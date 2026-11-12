/**
 * やりとりのスタック（設計は docs/設計.md 2節・5節）。
 *
 * - **VPC に入れない・Secrets Manager を使わない・KMS の鍵を作らない**（費用。キーは SSM の標準パラメータ）
 * - **キーのパラメータ（KEYS_PARAM）はここで作らない。** 中身を書くとテンプレートに残る。CLI の `admin key rotate` が作る
 * - S3 は「読む・無ければ書く」だけ。消す権限（DeleteObject）を持たせない（発言は消さない。設計 3節）
 * - DynamoDB の表（Rooms）は部屋・参加者・既読・部屋ごとの最新だけ（設計 12節）。関数に DeleteItem を持たせない（人を外すのは CLI）
 */
import { KEYS_PARAM, UPLOAD_KEEP_DAYS, WEB_GOOGLE_PARAM, WEB_SESSION_KEY_PARAM, WEB_VIEWERS_PARAM } from '@yaritori/schema'
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib'
import { AttributeType, Billing, TableEncryptionV2, TableV2 } from 'aws-cdk-lib/aws-dynamodb'
import { PolicyStatement } from 'aws-cdk-lib/aws-iam'
import { Architecture, FunctionUrlAuthType, Runtime } from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs'
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs'
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership } from 'aws-cdk-lib/aws-s3'
import type { Construct } from 'constructs'
import * as path from 'node:path'

const ROOT = path.join(__dirname, '..', '..')

export interface YaritoriStackProps extends StackProps {
  /**
   * 読む画面を開くドメイン（https://yaritori.example.com の形。Cloudflare の Worker がここで画面を配る）。
   * Google に登録する戻り先もここから組む。`npm run deploy:web` は出力 WebUrl からドメインを取る
   */
  webOrigin: string
}

export class YaritoriStack extends Stack {
  constructor(scope: Construct, id: string, props: YaritoriStackProps) {
    super(scope, id, props)
    if (!/^https:\/\/[a-z0-9.-]+$/.test(props.webOrigin)) {
      throw new Error(`YARITORI_WEB_ORIGIN は https://<ドメイン> の形で（末尾の / なし）: ${props.webOrigin}`)
    }
    const WEB_ORIGIN = props.webOrigin

    // 部屋・発言・添付・資料の置き場。**消さない**（設計 9節）ので、スタックを消してもバケットは残す。
    // バージョニングは、上書きで書くもの（room.json・既読の印）の前の版を残すため（資料の版は1つずつ別のオブジェクトで持つ）。
    // 消える設定にするのは、再送の判定（idem/）と、発言で指されなかった添付の一時置き場（uploads/）だけ
    const bucket = new Bucket(this, 'Store', {
      bucketName: `yaritori-${this.account}`,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        { id: 'idempotency-keys', prefix: 'idem/', expiration: Duration.days(7), noncurrentVersionExpiration: Duration.days(1) },
        // 書き手が署名付き URL で直接上げる一時置き場。発言で指されたものは rooms/ にコピー済みなので、2日で消してよい
        { id: 'uploads', prefix: 'uploads/', expiration: Duration.days(UPLOAD_KEEP_DAYS), noncurrentVersionExpiration: Duration.days(1) },
        { id: 'abort-multipart', abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
    })

    // 部屋・参加者・既読・部屋ごとの最新（設計 12節）。発言・添付・資料は S3。
    // **論理 ID（"Rooms"）を変えない。** 作り直されると中身が消える。削除保護・RETAIN・ポイントインタイムリカバリ（35日）。
    // 暗号化は AWS が持つ鍵（aws/dynamodb の鍵は KMS の料金がかかるので使わない）。TTL はかけない（消さない）。
    // オンデマンドに 1 秒あたりの上限をかけ、叩かれすぎても費用がふくらまないようにする（索引にも同じ上限を書く）
    const rooms = new TableV2(this, 'Rooms', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billing: Billing.onDemand({ maxReadRequestUnits: 100, maxWriteRequestUnits: 20 }),
      // 全部の部屋の一覧（読む画面・admin room list・muse が作った部屋の数）。部屋の行だけが gsi1pk = ROOMS を持つ
      globalSecondaryIndexes: [{
        indexName: 'gsi1',
        partitionKey: { name: 'gsi1pk', type: AttributeType.STRING },
        sortKey: { name: 'gsi1sk', type: AttributeType.STRING },
        maxReadRequestUnits: 100,
        maxWriteRequestUnits: 20,
      }],
      encryption: TableEncryptionV2.dynamoOwnedKey(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true, recoveryPeriodInDays: 35 },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    })
    const roomsArns = [rooms.tableArn, `${rooms.tableArn}/index/*`]

    const logGroup = new LogGroup(this, 'ApiLogs', {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    })

    // **論理 ID（"Api"）を変えない。** 作り直されると Function URL が変わり、書き手に渡した仕様の宛先が切れる。
    // 独自ドメインを挟まない（設計 9節）ので、変わったら書き手全員に渡し直すしかない
    const fn = new NodejsFunction(this, 'Api', {
      entry: path.join(ROOT, 'packages/api/src/lambda.ts'),
      projectRoot: ROOT,
      depsLockFilePath: path.join(ROOT, 'package-lock.json'),
      // zip のマネージドなランタイム。ランタイムの更新は AWS に任せる（コンテナにしない）
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      // 添付の中身は関数を通らない（署名付き URL）ので 256MB で足りる
      memorySize: 256,
      timeout: Duration.seconds(20),
      // 叩かれすぎを抑える（キーの無い要求でも関数は起きる）。アカウントの同時実行の上限が 10 のままだと置けない（docs/ホスティング.md）
      reservedConcurrentExecutions: 2,
      logGroup,
      environment: {
        STORE_BUCKET: bucket.bucketName,
        ROOMS_TABLE: rooms.tableName,
        KEYS_PARAM,
      },
      bundling: {
        format: OutputFormat.ESM,
        target: 'node24',
        mainFields: ['module', 'main'],
        // ランタイムに入っている SDK を使う
        externalModules: ['@aws-sdk/*'],
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
        // 書き手への説明（docs/書き手への説明.md）を文字として入れる（GET /v1/guide）
        loader: { '.md': 'text' },
      },
    })

    // 部屋（発言・添付・資料の版を書く）・再送の判定・添付の一時置き場。
    // uploads/ の PutObject は、書き手に渡す署名付き URL がこの権限で動くため（関数自身は書かない）
    fn.addToRolePolicy(new PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject'],
      resources: [bucket.arnForObjects('rooms/*'), bucket.arnForObjects('idem/*'), bucket.arnForObjects('uploads/*')],
    }))
    // 発言の一覧のため。もう1つの理由は、無いキーを読んだときに AccessDenied ではなく NoSuchKey を受け取るため。
    // このバケットはやりとり専用なので、接頭辞で絞らない
    fn.addToRolePolicy(new PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [bucket.bucketArn],
    }))
    // 部屋を作る（muse）・直す・既読・部屋ごとの最新。トランザクションは中の操作ごとの権限で動く。
    // DeleteItem は持たせない（人を部屋から外すのは CLI だけ）。全部を読む Scan も持たせない
    fn.addToRolePolicy(new PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:ConditionCheckItem'],
      resources: roomsArns,
    }))
    fn.addToRolePolicy(new PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: KEYS_PARAM.replace(/^\//, '') })],
    }))
    // SecureString の復号（AWS が持つ aws/ssm の鍵。SSM 経由のときだけ）
    fn.addToRolePolicy(new PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: ['*'],
      conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
    }))

    // 外の書き手（AI のクラウドなど）は AWS の署名を作れない前提なので、認証なしにしてキーは関数の中で見る
    const url = fn.addFunctionUrl({ authType: FunctionUrlAuthType.NONE })

    new CfnOutput(this, 'ApiUrl', { value: url.url, description: 'API endpoint (docs/openapi.yaml servers)' })
    new CfnOutput(this, 'StoreBucket', { value: bucket.bucketName })
    new CfnOutput(this, 'RoomsTable', { value: rooms.tableName, description: 'DynamoDB table for rooms, members, read marks (admin room / admin migrate)' })

    // ── 読む画面（2026-10-30）。画面は Cloudflare の Worker（packages/web）が配り、/api と /auth だけここへ中継される ──
    // 書き手の API（Api）とは別の関数にする。Google のログインで入り、**読むだけ**（S3 の GetObject と ListBucket だけで、
    // 書く権限を持たせない）。ログインの仕組みに穴があっても、発言・資料・既読の印には届かない
    const viewerLogs = new LogGroup(this, 'ViewerLogs', {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    })
    // **論理 ID（"Viewer"）を変えない。** 作り直されると Function URL が変わり、Worker の中継先（LAMBDA_ORIGIN）が切れる（deploy:web をやり直せば直る）
    const viewer = new NodejsFunction(this, 'Viewer', {
      entry: path.join(ROOT, 'packages/api/src/viewer-lambda.ts'),
      projectRoot: ROOT,
      depsLockFilePath: path.join(ROOT, 'package-lock.json'),
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(20),
      // 見るのは許可した人だけなので 2 で足りる（ログインしていない要求でも関数は起きる）
      reservedConcurrentExecutions: 2,
      logGroup: viewerLogs,
      environment: {
        STORE_BUCKET: bucket.bucketName,
        ROOMS_TABLE: rooms.tableName,
        VIEWERS_PARAM: WEB_VIEWERS_PARAM,
        GOOGLE_PARAM: WEB_GOOGLE_PARAM,
        SESSION_KEY_PARAM: WEB_SESSION_KEY_PARAM,
        PUBLIC_ORIGIN: WEB_ORIGIN,
      },
      bundling: {
        format: OutputFormat.ESM,
        target: 'node24',
        mainFields: ['module', 'main'],
        externalModules: ['@aws-sdk/*'],
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
    })
    // 添付は署名付き URL で渡すので、取り出す URL もこの GetObject で動く
    viewer.addToRolePolicy(new PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [bucket.arnForObjects('rooms/*')],
    }))
    viewer.addToRolePolicy(new PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [bucket.bucketArn],
    }))
    // 表も読むだけ（書く操作を持たせない）
    viewer.addToRolePolicy(new PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:Query'],
      resources: roomsArns,
    }))
    viewer.addToRolePolicy(new PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [WEB_VIEWERS_PARAM, WEB_GOOGLE_PARAM, WEB_SESSION_KEY_PARAM].map((p) =>
        this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: p.replace(/^\//, '') })),
    }))
    viewer.addToRolePolicy(new PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: ['*'],
      conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
    }))
    // ログインの確認は関数の中（google.ts）。Worker と同じく、判断を1か所にする
    const viewerUrl = viewer.addFunctionUrl({ authType: FunctionUrlAuthType.NONE })

    new CfnOutput(this, 'ViewerFunctionUrl', { value: viewerUrl.url, description: 'LAMBDA_ORIGIN of the yaritori-web Worker (npm run deploy:web passes it)' })
    new CfnOutput(this, 'WebUrl', { value: WEB_ORIGIN })
    new CfnOutput(this, 'WebCallbackUrl', { value: `${WEB_ORIGIN}/auth/callback`, description: 'Google OAuth client: authorized redirect URI' })
  }
}

import * as path from 'node:path';
import {
  Stack,
  StackProps,
  Duration,
  RemovalPolicy,
  CfnOutput,
  aws_ec2 as ec2,
  aws_rds as rds,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_cognito as cognito,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  triggers,
} from 'aws-cdk-lib';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import {
  HttpApi,
  HttpMethod,
  CorsHttpMethod,
  HttpNoneAuthorizer,
} from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { Construct } from 'constructs';

export interface IpamStackProps extends StackProps {
  appName: string;
  /** Email address of the initial Admin user. */
  adminEmail: string;
  /** Globally unique prefix for the Cognito hosted UI domain. */
  cognitoDomainPrefix: string;
  dbInstanceClass: string;
  dbMultiAz: boolean;
  dbAllocatedStorage: number;
  /**
   * When true the Lambda functions egress through a NAT gateway; when false
   * (the default) they run in isolated subnets and reach Secrets Manager via
   * an interface VPC endpoint, which is considerably cheaper.
   */
  useNatGateway: boolean;
}

/** Repository root, used as the bundling project root for Lambda assets. */
const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const API_DIR = path.join(REPO_ROOT, 'packages', 'api');
const WEB_DIST = path.join(REPO_ROOT, 'packages', 'web', 'dist');

export class IpamStack extends Stack {
  constructor(scope: Construct, id: string, props: IpamStackProps) {
    super(scope, id, props);

    const { appName } = props;

    /* ------------------------------------------------------------------ */
    /* Networking                                                          */
    /* ------------------------------------------------------------------ */

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: props.useNatGateway ? 1 : 0,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'private',
          subnetType: props.useNatGateway
            ? ec2.SubnetType.PRIVATE_WITH_EGRESS
            : ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // Without NAT the API Lambda still needs to read the database secret.
    if (!props.useNatGateway) {
      vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
        service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
        privateDnsEnabled: true,
      });
    }

    const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc,
      description: 'IPAM Lambda functions',
      allowAllOutbound: true,
    });

    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSg', {
      vpc,
      description: 'IPAM PostgreSQL database',
      allowAllOutbound: false,
    });

    dbSecurityGroup.addIngressRule(
      lambdaSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow the IPAM Lambda functions to reach PostgreSQL',
    );

    /* ------------------------------------------------------------------ */
    /* Database                                                            */
    /* ------------------------------------------------------------------ */

    const database = new rds.DatabaseInstance(this, 'Database', {
      vpc,
      vpcSubnets: {
        subnetType: props.useNatGateway
          ? ec2.SubnetType.PRIVATE_WITH_EGRESS
          : ec2.SubnetType.PRIVATE_ISOLATED,
      },
      securityGroups: [dbSecurityGroup],
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_4,
      }),
      instanceType: new ec2.InstanceType(props.dbInstanceClass),
      credentials: rds.Credentials.fromGeneratedSecret('ipam_admin', {
        secretName: `${appName}/database`,
      }),
      databaseName: 'ipam',
      allocatedStorage: props.dbAllocatedStorage,
      maxAllocatedStorage: Math.max(props.dbAllocatedStorage * 5, 100),
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      multiAz: props.dbMultiAz,
      backupRetention: Duration.days(7),
      deleteAutomatedBackups: false,
      deletionProtection: props.dbMultiAz,
      // Take a final snapshot rather than silently losing allocation data.
      removalPolicy: RemovalPolicy.SNAPSHOT,
      cloudwatchLogsExports: ['postgresql'],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,
      enablePerformanceInsights: false,
      autoMinorVersionUpgrade: true,
    });

    if (!database.secret) {
      throw new Error('Database secret was not created.');
    }
    const dbSecret = database.secret;

    /* ------------------------------------------------------------------ */
    /* Static site hosting (S3 + CloudFront)                               */
    /* ------------------------------------------------------------------ */

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${appName} — Cloud IPAM web application`,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        // Origin Access Control keeps the bucket private.
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
      // The SPA uses client-side routing, so unknown paths must serve the shell.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.minutes(5),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.minutes(5),
        },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // minimumProtocolVersion is intentionally omitted: it only takes effect
      // with a custom certificate. Add one here alongside `domainNames` if you
      // put this behind your own DNS name.
    });

    const siteUrl = `https://${distribution.distributionDomainName}`;

    /* ------------------------------------------------------------------ */
    /* Authentication (Cognito)                                            */
    /* ------------------------------------------------------------------ */

    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${appName}-users`,
      // Users are provisioned by an administrator, not self sign-up.
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: false },
        fullname: { required: false, mutable: true },
      },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(7),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // Threat protection in audit mode: log risk signals without blocking.
      featurePlan: cognito.FeaturePlan.PLUS,
      standardThreatProtectionMode:
        cognito.StandardThreatProtectionMode.AUDIT_ONLY,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const userPoolDomain = userPool.addDomain('HostedUiDomain', {
      cognitoDomain: { domainPrefix: props.cognitoDomainPrefix },
    });

    const userPoolClient = userPool.addClient('WebClient', {
      userPoolClientName: `${appName}-web`,
      generateSecret: false,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: [siteUrl, 'http://localhost:5173'],
        logoutUrls: [siteUrl, 'http://localhost:5173'],
      },
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
    });

    // Groups drive authorisation: only Editor and Admin may modify data.
    const groups: Record<string, { description: string; precedence: number }> = {
      Admin: {
        description: 'Full access: modify allocations, view the audit trail.',
        precedence: 1,
      },
      Editor: {
        description: 'Can add, edit and delete allocation rows.',
        precedence: 2,
      },
      Viewer: {
        description: 'Read-only access to allocations and dashboards.',
        precedence: 3,
      },
    };

    for (const [name, cfg] of Object.entries(groups)) {
      new cognito.CfnUserPoolGroup(this, `Group${name}`, {
        userPoolId: userPool.userPoolId,
        groupName: name,
        description: cfg.description,
        precedence: cfg.precedence,
      });
    }

    // Seed the first administrator so the app is usable immediately.
    const adminUser = new cognito.CfnUserPoolUser(this, 'AdminUser', {
      userPoolId: userPool.userPoolId,
      username: props.adminEmail,
      desiredDeliveryMediums: ['EMAIL'],
      userAttributes: [
        { name: 'email', value: props.adminEmail },
        { name: 'email_verified', value: 'true' },
      ],
    });

    const adminMembership = new cognito.CfnUserPoolUserToGroupAttachment(
      this,
      'AdminMembership',
      {
        userPoolId: userPool.userPoolId,
        groupName: 'Admin',
        username: props.adminEmail,
      },
    );
    // The user and the Admin group must both exist before the attachment.
    adminMembership.addResourceDependency(adminUser);
    adminMembership.addResourceDependency(
      this.node.findChild('GroupAdmin') as cognito.CfnUserPoolGroup,
    );

    /* ------------------------------------------------------------------ */
    /* API (Lambda + API Gateway HTTP API)                                 */
    /* ------------------------------------------------------------------ */

    const lambdaEnvironment: Record<string, string> = {
      DB_SECRET_ARN: dbSecret.secretArn,
      DB_NAME: 'ipam',
      COGNITO_USER_POOL_ID: userPool.userPoolId,
      COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
      CORS_ALLOW_ORIGIN: siteUrl,
      NODE_OPTIONS: '--enable-source-maps',
    };

    const commonFunctionProps = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      vpc,
      vpcSubnets: {
        subnetType: props.useNatGateway
          ? ec2.SubnetType.PRIVATE_WITH_EGRESS
          : ec2.SubnetType.PRIVATE_ISOLATED,
      },
      securityGroups: [lambdaSecurityGroup],
      environment: lambdaEnvironment,
      projectRoot: REPO_ROOT,
      depsLockFilePath: path.join(REPO_ROOT, 'package-lock.json'),
      bundling: {
        format: OutputFormat.CJS,
        target: 'node22',
        minify: true,
        sourceMap: true,
        externalModules: [
          // Provided by the Lambda runtime.
          '@aws-sdk/*',
          // Optional native/edge drivers that `pg` requires lazily.
          'pg-native',
          'cloudflare:sockets',
        ],
      },
    };

    const apiFunction = new NodejsFunction(this, 'ApiFunction', {
      ...commonFunctionProps,
      entry: path.join(API_DIR, 'src', 'handler.ts'),
      handler: 'handler',
      description: 'IPAM REST API',
      memorySize: 512,
      timeout: Duration.seconds(29),
      logGroup: new logs.LogGroup(this, 'ApiFunctionLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

    dbSecret.grantRead(apiFunction);

    // The migration function ships the .sql files alongside the bundle.
    const migrationFunction = new NodejsFunction(this, 'MigrationFunction', {
      ...commonFunctionProps,
      entry: path.join(API_DIR, 'src', 'migrate.ts'),
      handler: 'handler',
      description: 'Applies IPAM database migrations',
      memorySize: 512,
      timeout: Duration.minutes(5),
      environment: { ...lambdaEnvironment, MIGRATIONS_DIR: '/var/task/migrations' },
      logGroup: new logs.LogGroup(this, 'MigrationFunctionLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      bundling: {
        ...commonFunctionProps.bundling,
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `mkdir -p ${outputDir}/migrations`,
            `cp ${inputDir}/packages/api/migrations/*.sql ${outputDir}/migrations/`,
          ],
        },
      },
    });

    dbSecret.grantRead(migrationFunction);

    // Run migrations automatically once the database is available.
    new triggers.Trigger(this, 'RunMigrations', {
      handler: migrationFunction,
      timeout: Duration.minutes(5),
      invocationType: triggers.InvocationType.REQUEST_RESPONSE,
      executeAfter: [database],
      executeOnHandlerChange: true,
    });

    const authorizer = new HttpUserPoolAuthorizer('CognitoAuthorizer', userPool, {
      userPoolClients: [userPoolClient],
      identitySource: ['$request.header.Authorization'],
    });

    const httpApi = new HttpApi(this, 'HttpApi', {
      apiName: `${appName}-api`,
      description: 'Cloud IPAM REST API',
      corsPreflight: {
        allowOrigins: [siteUrl, 'http://localhost:5173'],
        allowHeaders: ['authorization', 'content-type'],
        allowMethods: [
          CorsHttpMethod.GET,
          CorsHttpMethod.POST,
          CorsHttpMethod.PUT,
          CorsHttpMethod.PATCH,
          CorsHttpMethod.DELETE,
          CorsHttpMethod.OPTIONS,
        ],
        allowCredentials: false,
        maxAge: Duration.hours(1),
      },
      defaultAuthorizer: authorizer,
    });

    const integration = new HttpLambdaIntegration('ApiIntegration', apiFunction);

    // Health check must stay reachable without a token for monitoring.
    httpApi.addRoutes({
      path: '/health',
      methods: [HttpMethod.GET],
      integration,
      authorizer: new HttpNoneAuthorizer(),
    });

    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [HttpMethod.ANY],
      integration,
    });

    const apiUrl = httpApi.apiEndpoint;

    /* ------------------------------------------------------------------ */
    /* Web deployment                                                       */
    /* ------------------------------------------------------------------ */

    // The built bundle is environment-agnostic; config.json supplies the
    // stack-specific values at deploy time, resolved from CloudFormation.
    new s3deploy.BucketDeployment(this, 'DeployWeb', {
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
      prune: true,
      sources: [
        s3deploy.Source.asset(WEB_DIST),
        s3deploy.Source.jsonData('config.json', {
          apiBaseUrl: apiUrl,
          cognitoAuthority: `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
          cognitoClientId: userPoolClient.userPoolClientId,
          cognitoDomain: `https://${userPoolDomain.domainName}.auth.${this.region}.amazoncognito.com`,
          redirectUri: siteUrl,
          logoutUri: siteUrl,
        }),
      ],
    });

    /* ------------------------------------------------------------------ */
    /* Outputs                                                              */
    /* ------------------------------------------------------------------ */

    new CfnOutput(this, 'WebsiteUrl', {
      value: siteUrl,
      description: 'Open this URL to use the IPAM application',
    });

    new CfnOutput(this, 'ApiUrl', {
      value: apiUrl,
      description: 'Base URL of the IPAM REST API',
    });

    new CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito user pool ID (manage users and group membership here)',
    });

    new CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito app client ID',
    });

    new CfnOutput(this, 'CognitoHostedUiDomain', {
      value: `https://${userPoolDomain.domainName}.auth.${this.region}.amazoncognito.com`,
      description: 'Cognito hosted UI domain',
    });

    new CfnOutput(this, 'DatabaseSecretArn', {
      value: dbSecret.secretArn,
      description: 'Secrets Manager ARN holding the PostgreSQL credentials',
    });

    new CfnOutput(this, 'DatabaseEndpoint', {
      value: database.dbInstanceEndpointAddress,
      description: 'PostgreSQL endpoint (reachable only from inside the VPC)',
    });

    new CfnOutput(this, 'AddUserCommand', {
      value:
        `aws cognito-idp admin-create-user --user-pool-id ${userPool.userPoolId}` +
        ' --username USER@EXAMPLE.COM --user-attributes Name=email,Value=USER@EXAMPLE.COM Name=email_verified,Value=true',
      description: 'Create an additional user',
    });

    new CfnOutput(this, 'GrantEditorCommand', {
      value:
        `aws cognito-idp admin-add-user-to-group --user-pool-id ${userPool.userPoolId}` +
        ' --username USER@EXAMPLE.COM --group-name Editor',
      description: 'Grant a user permission to modify rows',
    });
  }
}

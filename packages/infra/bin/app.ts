#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { IpamStack } from '../lib/ipam-stack';

const app = new cdk.App();

/** Read a context value, falling back to a default. */
function ctx(key: string, fallback = ''): string {
  return (app.node.tryGetContext(key) as string | undefined) ?? fallback;
}

const appName = ctx('appName', 'ipam');
const adminEmail = ctx('adminEmail');
const cognitoDomainPrefix = ctx('cognitoDomainPrefix');

if (!adminEmail) {
  // Fail fast with actionable guidance rather than deploying an app nobody
  // can sign in to.
  throw new Error(
    'adminEmail is required. Deploy with:\n' +
      '  npx cdk deploy -c adminEmail=you@example.com -c cognitoDomainPrefix=my-unique-prefix',
  );
}

if (!cognitoDomainPrefix) {
  throw new Error(
    'cognitoDomainPrefix is required and must be globally unique. Deploy with:\n' +
      '  npx cdk deploy -c adminEmail=you@example.com -c cognitoDomainPrefix=my-unique-prefix',
  );
}

new IpamStack(app, `${appName}-stack`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description:
    'Cloud IPAM — IP address allocation management for AWS and Azure (S3/CloudFront + API Gateway + Lambda + RDS Postgres + Cognito)',
  appName,
  adminEmail,
  cognitoDomainPrefix,
  dbInstanceClass: ctx('dbInstanceClass', 't4g.micro'),
  dbMultiAz: ctx('dbMultiAz', 'false') === 'true',
  dbAllocatedStorage: Number(ctx('dbAllocatedStorage', '20')),
  useNatGateway: ctx('useNatGateway', 'false') === 'true',
});

app.synth();

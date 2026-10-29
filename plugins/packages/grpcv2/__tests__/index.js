'use strict';

// got v14 is ESM-only and Jest cannot load it here. It is only used to fetch proto files from a URL,
// which these filesystem-mode tests never do.
jest.mock('got', () => jest.fn());

const fs = require('fs');
const os = require('os');
const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { QueryError } = require('@tooljet-plugins/common');
const grpcv2 = require('../lib');

const PROTO = `
syntax = "proto3";

package demo;

message PingRequest {
  string text = 1;
}

message PingReply {
  string text = 1;
}

service Greeter {
  rpc Ping (PingRequest) returns (PingReply);
}

service Billing {
  rpc Ping (PingRequest) returns (PingReply);
}
`;

describe('grpcv2', () => {
  const service = new grpcv2.default();
  let protoDir;
  let server;
  let port;
  const calls = [];

  beforeAll(async () => {
    protoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grpcv2-test-'));
    const protoPath = path.join(protoDir, 'demo.proto');
    fs.writeFileSync(protoPath, PROTO);

    const demo = grpc.loadPackageDefinition(protoLoader.loadSync(protoPath)).demo;
    const handler = (name) => (call, callback) => {
      calls.push(name);
      callback(null, { text: `${name}:${call.request.text}` });
    };

    server = new grpc.Server();
    server.addService(demo.Greeter.service, { Ping: handler('Greeter') });
    server.addService(demo.Billing.service, { Ping: handler('Billing') });
    port = await new Promise((resolve, reject) => {
      server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, boundPort) =>
        err ? reject(err) : resolve(boundPort)
      );
    });
  });

  afterAll(() => {
    server?.forceShutdown();
    if (protoDir) fs.rmSync(protoDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    calls.length = 0;
  });

  const filesystemSourceOptions = (overrides = {}) => ({
    url: `127.0.0.1:${port}`,
    proto_files: 'import_protos_from_filesystem',
    proto_files_directory: protoDir,
    proto_files_pattern: '**/*.proto',
    auth_type: 'none',
    ssl_enabled: false,
    ...overrides,
  });

  const pingQuery = (serviceName) => ({
    service: `demo.${serviceName}`,
    method: 'Ping',
    raw_message: '{ "text": "hi" }',
  });

  describe('filesystem mode', () => {
    it('runs a query for a service selected in the data source config', async () => {
      const sourceOptions = filesystemSourceOptions({ selected_services: ['demo.Greeter'] });

      const result = await service.run(sourceOptions, pingQuery('Greeter'));

      expect(result).toEqual({ status: 'ok', data: { text: 'Greeter:hi' } });
      expect(calls).toEqual(['Greeter']);
    });

    it('refuses to run a query for a service that was removed from the data source config', async () => {
      const sourceOptions = filesystemSourceOptions({ selected_services: ['demo.Greeter'] });

      const error = await service.run(sourceOptions, pingQuery('Billing')).catch((e) => e);

      expect(error).toBeInstanceOf(QueryError);
      expect(error.description).toContain('Service demo.Billing is not configured for this data source');
      expect(calls).toEqual([]);
    });

    it('refuses to run a query when every service was removed from the data source config', async () => {
      const sourceOptions = filesystemSourceOptions({ selected_services: [] });

      const error = await service.run(sourceOptions, pingQuery('Greeter')).catch((e) => e);

      expect(error).toBeInstanceOf(QueryError);
      expect(error.description).toContain('Service demo.Greeter is not configured for this data source');
      expect(calls).toEqual([]);
    });

    it('keeps running queries for data sources saved before services could be selected', async () => {
      const result = await service.run(filesystemSourceOptions(), pingQuery('Billing'));

      expect(result).toEqual({ status: 'ok', data: { text: 'Billing:hi' } });
      expect(calls).toEqual(['Billing']);
    });
  });
});

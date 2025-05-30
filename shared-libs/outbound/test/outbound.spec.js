const assert = require('chai').assert;
const sinon = require('sinon');
const rewire = require('rewire');
const secureSettings = require('@medic/settings');
const serverInfo = require('@medic/server-info');
const request = require('@medic/couch-request');
let outbound;

describe('outbound shared library', () => {
  afterEach(() => sinon.restore());

  describe('send', () => {
    let restores;
    let mapDocumentToPayload;
    let alreadySent;
    let sendPayload;

    beforeEach(() => {
      restores = [];

      outbound = rewire('../src/outbound');

      mapDocumentToPayload = sinon.stub();
      restores.push(outbound.__set__('mapDocumentToPayload', mapDocumentToPayload));

      alreadySent = sinon.stub();
      restores.push(outbound.__set__('alreadySent', alreadySent));

      sendPayload = sinon.stub();
      restores.push(outbound.__set__('sendPayload', sendPayload));
    });

    afterEach(() => restores.forEach(restore => restore()));

    const config = {some: 'config'};
    const configName = 'someConfig';
    const record = {some: 'record'};
    const recordInfo = {some: 'recordInfo'};
    const payload = {some: 'payload'};

    const error = {oh: 'no'};

    it('Maps and sends', () => {
      mapDocumentToPayload.resolves(payload);
      sendPayload.resolves();

      return outbound.send(config, configName, record, recordInfo)
        .then(() => {
          assert.equal(mapDocumentToPayload.callCount, 1);
          assert.equal(sendPayload.callCount, 1);

          assert.deepEqual(mapDocumentToPayload.args[0], [record, config, configName]);
          assert.deepEqual(sendPayload.args[0], [payload, config]);
        });
    });

    it('Propagates a mapping error', () => {
      mapDocumentToPayload.rejects(error);

      return outbound.send(config, configName, record)
        .catch(err => err)
        .then(err => {
          assert.equal(mapDocumentToPayload.callCount, 1);
          assert.equal(sendPayload.callCount, 0);

          assert.deepEqual(err, error);
        });
    });

    it('Propagates a sending error', () => {
      mapDocumentToPayload.resolves(payload);
      alreadySent.returns(false);
      sendPayload.rejects(error);

      return outbound.send(config, configName, record, recordInfo)
        .catch(err => err)
        .then(err => {
          assert.equal(mapDocumentToPayload.callCount, 1);
          assert.equal(sendPayload.callCount, 1);

          assert.deepEqual(err, error);
        });
    });
  });

  describe('mapDocumentToPayload', () => {
    let mapDocumentToPayload;
    beforeEach(() => {
      mapDocumentToPayload = outbound.__get__('mapDocumentToPayload');
    });

    it('supports simple dest => src mapping', () => {
      const doc = {
        _id: 'test-doc',
        foo: 42,
        bar: 'baaa'
      };

      const conf = {
        mapping: {
          'api_foo': 'doc.foo',
          'bar': 'doc.bar'
        }
      };

      assert.deepEqual(mapDocumentToPayload(doc, conf, 'test-doc'), {
        api_foo: 42,
        bar: 'baaa'
      });
    });

    it('supports deep dest => src mapping', () => {
      const doc = {
        _id: 'test-doc',
        reported_date: 42,
        fields: {
          foo: 'baaaaa'
        }
      };

      const conf = {
        mapping: {
          'when': 'doc.reported_date',
          'data.the_foo': 'doc.fields.foo'
        }
      };

      assert.deepEqual(mapDocumentToPayload(doc, conf, 'test-doc'), {
        when: 42,
        data: {
          the_foo: 'baaaaa'
        }
      });
    });

    it('errors if src path does not exist', () => {
      const doc = {
        _id: 'test-doc',
        reported_date: 42,
        fields: {
          not_foo: 'baaaaa'
        }
      };

      const conf = {
        mapping: {
          'foo': 'doc.fields.foo'
        }
      };

      assert.throws(() => mapDocumentToPayload(doc, conf, 'test-config'), `Mapping error for 'test-config/foo' on ` +
        `source document 'test-doc': cannot find 'doc.fields.foo' on source document`);
    });

    it('supports optional path mappings', () => {
      const doc = {
        _id: 'test-doc',
        reported_date: 42,
        fields: {
          not_foo: 'baaaaa',
          bar: 42
        }
      };

      const conf = {
        mapping: {
          foo: {
            path: 'doc.fields.foo',
            optional: true
          },
          bar: 'doc.fields.bar'
        }
      };

      assert.deepEqual(mapDocumentToPayload(doc, conf, 'test-doc'), {
        bar: 42
      });
    });

    it('supports basic awkward data conversion via arbitrary expressions', () => {
      const doc = {
        _id: 'test-doc',
        fields: {
          a_list: ['a', 'b', 'c', 'd'],
          foo: 'No',
        }
      };

      const conf = {
        mapping: {
          list_count: {expr: 'doc.fields.a_list.length'},
          foo: {expr: 'doc.fields.foo === \'Yes\''},
        }
      };
      assert.deepEqual(mapDocumentToPayload(doc, conf, 'test-doc'), {
        list_count: 4,
        foo: false
      });
    });

    it('throws a useful exception if the expression errors', () => {
      const doc = {
        _id: 'test-doc',
      };

      const conf = {
        mapping: {
          is_gonna_fail: {expr: 'doc.fields.null.pointer'},
        }
      };

      assert.throws(() => mapDocumentToPayload(doc, conf, 'test-doc'), /Mapping error/);
    });

    it('throws an exception if the expression does not have either path or expr', () => {
      const doc = {
        _id: 'test-doc',
      };

      const conf = {
        mapping: {
          is_gonna_fail: {not_path_or_expr: 'doc.fields.null.pointer'},
        }
      };

      assert.throws(() => mapDocumentToPayload(doc, conf, 'test-doc'), /Mapping error.*'expr' or 'path' is required/);
    });
  });

  describe('updateInfo', () => {
    it('Updates a passed infodoc with completion information', () => {
      const info = {
        _id: 'some-info',
        completed_tasks: []
      };

      outbound.__get__('updateInfo')({some: 'payload'}, info, 'test-config');

      assert.equal(info.completed_tasks.length, 1);
      assert.equal(info.completed_tasks[0].type, 'outbound');
      assert.equal(info.completed_tasks[0].name, 'test-config');
      assert.isAbove(info.completed_tasks[0].timestamp, 0);
    });
    it('Even if that infodoc has no prior completed tasks', () => {
      const info = {
        _id: 'some-info',
      };

      outbound.__get__('updateInfo')({some: 'payload'}, info, 'test-config');

      assert.equal(info.completed_tasks.length, 1);
      assert.equal(info.completed_tasks[0].type, 'outbound');
      assert.equal(info.completed_tasks[0].name, 'test-config');
      assert.isAbove(info.completed_tasks[0].timestamp, 0);
    });
  });

  describe('push', () => {
    it('should push on minimal configuration with version in User-Agent', () => {
      const payload = {
        some: 'data'
      };

      const conf = {
        destination: {
          base_url: 'http://test',
          path: '/foo'
        }
      };

      sinon.stub(serverInfo, 'getVersion').resolves('4.18.0');
      sinon.stub(request, 'post').resolves();

      return outbound.__get__('sendPayload')(payload, conf)
        .then(() => {
          assert.equal(request.post.callCount, 1);
          assert.deepEqual(request.post.args, [
            [
              {
                url: 'http://test/foo',
                body: { some: 'data' },
                timeout: 10000,
              }
            ]
          ]);
        });
    });

    it('should support pushing via basic auth', () => {
      const payload = {
        some: 'data'
      };

      const conf = {
        destination: {
          auth: {
            type: 'Basic',
            username: 'admin',
            password_key: 'test-config'
          },
          base_url: 'http://test',
          path: '/foo'
        }
      };

      sinon.stub(secureSettings, 'getCredentials').resolves('pass');
      sinon.stub(request, 'post').resolves();

      return outbound.__get__('sendPayload')(payload, conf)
        .then(() => {
          assert.equal(secureSettings.getCredentials.callCount, 1);
          assert.deepEqual(secureSettings.getCredentials.args, [['test-config']]);
          assert.equal(request.post.callCount, 1);
          assert.deepEqual(request.post.args, [
            [
              {
                url: 'http://test/foo',
                body: { some: 'data' },
                timeout: 10000,
                auth: {
                  username: 'admin',
                  password: 'pass'
                }
              }
            ]
          ]);
        });
    });

    it('should support pushing via header auth', () => {
      const payload = {
        some: 'data'
      };

      const conf = {
        destination: {
          auth: {
            type: 'Header',
            name: 'Authorization',
            value_key: 'test-config'
          },
          base_url: 'http://test',
          path: '/foo'
        }
      };

      sinon.stub(secureSettings, 'getCredentials').resolves('Bearer credentials');
      sinon.stub(request, 'post').resolves();

      return outbound.__get__('sendPayload')(payload, conf)
        .then(() => {
          assert.equal(secureSettings.getCredentials.callCount, 1);
          assert.deepEqual(secureSettings.getCredentials.args, [['test-config']]);
          assert.equal(request.post.callCount, 1);
          assert.deepEqual(request.post.args, [
            [
              {
                url: 'http://test/foo',
                body: { some: 'data' },
                timeout: 10000,
                headers: {
                  'authorization': 'Bearer credentials'
                }
              }
            ]
          ]);
        });
    });

    it('should support Muso SIH custom auth', () => {
      const payload = {
        some: 'data'
      };

      const conf = {
        destination: {
          auth: {
            type: 'muso-sih',
            username: 'admin',
            password_key: 'test-config',
            path: '/login'
          },
          base_url: 'http://test',
          path: '/foo'
        }
      };

      sinon.stub(secureSettings, 'getCredentials').resolves('pass');
      const post = sinon.stub(request, 'post');

      post.onCall(0).resolves({
        statut: 200,
        message: 'Requête traitée avec succès.',
        data: {
          username_token: 'j9NAhVDdVWkgo1xnbxA9V3Pmp'
        }
      });
      post.onCall(1).resolves();

      return outbound.__get__('sendPayload')(payload, conf)
        .then(() => {
          assert.equal(post.callCount, 2);
          assert.deepEqual(post.args, [
            [
              {
                url: 'http://test/login',
                form: {
                  login: 'admin',
                  password: 'pass'
                },
                timeout: 10000
              }
            ],
            [
              {
                url: 'http://test/foo',
                body: { some: 'data' },
                timeout: 10000,
                qs: {
                  token: 'j9NAhVDdVWkgo1xnbxA9V3Pmp'
                }
              }
            ]
          ]);
        });
    });

    it('should error if Muso SIH custom auth fails to return a 200', () => {
      const payload = {
        some: 'data'
      };

      const conf = {
        destination: {
          auth: {
            type: 'muso-sih',
            username: 'admin',
            password_key: 'test-config',
            path: '/login'
          },
          base_url: 'http://test',
          path: '/foo'
        }
      };

      sinon.stub(secureSettings, 'getCredentials').resolves('wrong pass');

      sinon.stub(request, 'post').resolves({
        statut: 404,
        message: 'Login/Mot de passe Incorrect !'
      });

      return outbound.__get__('sendPayload')(payload, conf)
        .then(() => {
          assert.fail('This send should have errored');
        })
        .catch(err => {
          assert.equal(err.message, 'Got 404 when requesting auth');
        });
    });
  });

  describe('alreadySent', () => {
    it('returns false if this record has never been sent anywhere', () => {
      assert.isNotOk(outbound.__get__('alreadySent')({some: 'payload'}, 'foo', {_id: 'some-record-info'}));
    });

    it('returns false if this record has been sent outbound, but not for this config', () => {
      assert.isNotOk(outbound.__get__('alreadySent')({some: 'payload'}, 'foo', {
        _id: 'some-record-info',
        completed_tasks: [{
          type: 'outbound',
          name: 'bar',
          timestamp: Date.now()
        }]
      }));
    });

    it('returns false if this record has been sent outbound, for this config with a different payload', () => {
      assert.isNotOk(outbound.__get__('alreadySent')({some: 'payload'}, 'foo', {
        _id: 'some-record-info',
        completed_tasks: [{
          type: 'outbound',
          name: 'bar',
          timestamp: Date.now()
        }, {
          type: 'outbound',
          name: 'foo',
          hash: 'somehashthatisnotright',
          timestamp: Date.now()
        }]
      }));
    });

    it('returns false if this record has been sent outbound, for this config and payload (not most recently)', () => {
      assert.isNotOk(outbound.__get__('alreadySent')({some: 'payload'}, 'foo', {
        _id: 'some-record-info',
        completed_tasks: [{
          type: 'outbound',
          name: 'bar',
          timestamp: Date.now()
        }, {
          type: 'outbound',
          name: 'foo',
          hash: '69b2c6f726b3c4be45ecee8370f1e05754557595aa930c5c6e6cd6c51a123d3b',
          timestamp: Date.now()
        }, {
          type: 'outbound',
          name: 'foo',
          hash: 'somehashthatisnotright',
          timestamp: Date.now()
        }]
      }));
    });

    it('returns true if this record has been sent outbound, for this config and payload (most recently)', () => {
      assert.isOk(outbound.__get__('alreadySent')({some: 'payload'}, 'foo', {
        _id: 'some-record-info',
        completed_tasks: [{
          type: 'outbound',
          name: 'bar',
          timestamp: Date.now()
        }, {
          type: 'outbound',
          name: 'foo',
          hash: '5d8d96384c4f20565803d386aef2328e35928bb97e6883e241005b4bab868488',
          timestamp: Date.now()
        }]
      }));
    });
  });

  describe('consistent hash', () => {
    it('generates a consistent hash regardless of object item ordering', () => {
      // This is the problem our custom code solves
      assert.notEqual(
        JSON.stringify({a: 'a', b: 'b'}),
        JSON.stringify({b: 'b', a: 'a'}),
      );

      // We are also testing for exact hash strings to detect if refactors cause the hashes to change

      // Simple reordering tests
      assert.equal(
        outbound.__get__('hash')({b: 'b', a: 'a'}),
        '5b6fc73120d59ff048925bd03a11d53e1b1837a0f637569716a97a1ca96891b3'
      );
      assert.equal(
        outbound.__get__('hash')({a: 'a', b: 'b'}),
        '5b6fc73120d59ff048925bd03a11d53e1b1837a0f637569716a97a1ca96891b3'
      );

      // Recursive reordering tests
      assert.equal(outbound.__get__('hash')({
        a: {
          b: 'ab',
          a: 'aa'
        },
        b: {
          a: 'ba',
          b: 'bb'
        }
      }), '4c48e262921875e73d2529d5f6bcc578dd2f747feb61ac5d2018bb985350420a');
      assert.equal(outbound.__get__('hash')({
        b: {
          b: 'bb',
          a: 'ba'
        },
        a: {
          a: 'aa',
          b: 'ab'
        }
      }), '4c48e262921875e73d2529d5f6bcc578dd2f747feb61ac5d2018bb985350420a');

      // Built ordering tests
      const builtOrderOne = {};
      builtOrderOne.b = 'b';
      builtOrderOne.a = 'a';
      assert.equal(
        outbound.__get__('hash')(builtOrderOne),
        '5b6fc73120d59ff048925bd03a11d53e1b1837a0f637569716a97a1ca96891b3'
      );

      const builtOrderTwo = {};
      builtOrderTwo.a = 'a';
      builtOrderTwo.b = 'b';
      assert.equal(
        outbound.__get__('hash')(builtOrderTwo),
        '5b6fc73120d59ff048925bd03a11d53e1b1837a0f637569716a97a1ca96891b3'
      );
    });

    it('preserves array item ordering', () => {
      assert.equal(
        outbound.__get__('hash')({foos: ['b', 'a']}),
        '379ad62f0fe91c34ef9d3dcc7302990fdb31bbeee7862a2718e5358dd7c8d152'
      );

      assert.equal(
        outbound.__get__('hash')({foos: ['a', 'b']}),
        '34b5f1c4698211dcbee90707ac204c80e90cc581e590ede5c530a7a0df05f9dc'
      );
    });

    it('doesnt mess up numbers or dates', () => {
      assert.equal(
        outbound.__get__('orderedStringify')({blah: new Date(Date.UTC(2020, 1, 1))}),
        '{"blah":"2020-02-01T00:00:00.000Z"}'
      );
    });
  });
});

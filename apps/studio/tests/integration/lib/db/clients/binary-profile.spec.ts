import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers'
import { accumulate, profilingEnabled, report } from '@/lib/perf'
import type { IDbConnectionServerConfig } from '@/lib/db/types'

// Profiling harness for the large-binary select pipeline against a real Postgres.
//
//   BKS_BINARY_PROFILE=1 BKS_PROFILE=1 TEST_MODE=1 npx jest \
//     --config ./jest.integration.config.js \
//     tests/integration/lib/db/clients/binary-profile.spec.ts
//
// Seeds a table with multi-MB bytea rows, then runs the REAL client selectTop
// (query + transcoder serialization) with BKS_PROFILE timings, plus a
// structuredClone pass simulating the renderer IPC hop.

const enabled = !!process.env.BKS_BINARY_PROFILE
const d = enabled ? describe : describe.skip

// createServer imports every client; stub the ones with native addons that are
// compiled against Electron's ABI and cannot load under plain-node jest.
jest.mock('sqlanywhere', () => ({}), { virtual: true })
jest.mock('msnodesqlv8', () => ({ default: {} }), { virtual: true })
jest.mock('oracledb', () => ({}), { virtual: true })
jest.mock('sqlite3', () => ({}), { virtual: true })
jest.mock('@duckdb/node-api', () => ({}), { virtual: true })

const ROWS = 100
const BLOB_BYTES = 2 * 1024 * 1024
const PAGE_SIZE = 20

d('binary selectTop profile', () => {
  let container: StartedTestContainer
  let connection: any
  // deterministic pseudo-random content, generated once and reused per row
  const blob = Buffer.alloc(BLOB_BYTES)
  for (let i = 0; i < BLOB_BYTES; i += 4096) {
    blob[i] = (i * 31) % 256
  }

  beforeAll(async () => {
    // platform_info expects Electron's process.resourcesPath outside dev mode;
    // plain-node jest only has it when running under the Electron binary.
    if (!process.resourcesPath) process.resourcesPath = __dirname

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createServer } = require('@commercial/backend/lib/db/server')

    container = await new GenericContainer('postgres:17')
      .withEnvironment({
        POSTGRES_PASSWORD: 'example',
        POSTGRES_DB: 'banana',
      })
      .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2))
      .withExposedPorts(5432)
      .withStartupTimeout(120000)
      .start()

    const config: IDbConnectionServerConfig = {
      client: 'postgresql',
      host: container.getHost(),
      port: container.getMappedPort(5432),
      user: 'postgres',
      password: 'example',
      osUser: 'profile',
      ssh: null,
      sslCaFile: null,
      sslCertFile: null,
      sslKeyFile: null,
      sslRejectUnauthorized: false,
      ssl: false,
      domain: null,
      socketPath: null,
      socketPathEnabled: false,
      readOnlyMode: false,
    }

    const server = createServer(config)
    connection = server.createConnection('banana')
    await connection.connect()

    await connection.driverExecuteSingle(`
      CREATE TABLE binary_blobs (
        id serial PRIMARY KEY,
        name text NOT NULL,
        data bytea NOT NULL,
        data2 bytea
      )
    `)

    // seed in chunks so parameter payloads stay manageable
    const CHUNK = 10
    for (let offset = 0; offset < ROWS; offset += CHUNK) {
      const values: any[] = []
      const placeholders: string[] = []
      let idx = 0
      for (let i = 0; i < CHUNK; i++) {
        const id = offset + i
        placeholders.push(`($${++idx}, $${++idx}, $${++idx})`)
        values.push(`row-${id}`, blob, id % 2 ? blob : null)
      }
      await connection.driverExecuteSingle(
        `INSERT INTO binary_blobs (name, data, data2) VALUES ${placeholders.join(',')}`,        { params: values }
      )
    }
  }, 300000)

  afterAll(async () => {
    await connection?.disconnect()
    await container?.stop()
  })

  it('profiles selectTop over large bytea rows', async () => {
    expect(profilingEnabled()).toBe(true)

    const result = await connection.selectTop('binary_blobs', 0, PAGE_SIZE, [], [], 'public', ['*'])
    expect(result.result.length).toBe(PAGE_SIZE)

    const payload = { result: result.result, fields: result.fields }
    let binaryBytes = 0
    for (const row of payload.result) {
      for (const value of Object.values(row)) {
        if (value instanceof Uint8Array) binaryBytes += value.byteLength
      }
    }
    const cloneStart = performance.now()
    const cloned = structuredClone(payload)
    accumulate('simulated.ipc-clone', performance.now() - cloneStart, binaryBytes)
    expect(cloned.result.length).toBe(PAGE_SIZE)

    report()
  }, 300000)
})

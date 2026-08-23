import helpers, { MAX_CELL_CHARS } from '@/shared/lib/tabulator'

const toHex = (bytes: Uint8Array) => Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')

describe('niceString', () => {
  it('keeps the legacy truncate length of 256', () => {
    expect(MAX_CELL_CHARS).toBe(256)
  })

  it('returns full binary conversion when truncate is false', () => {
    expect(helpers.niceString(new Uint8Array([1, 2, 3]), false, 'hex')).toBe('010203')
    expect(helpers.niceString(new Uint8Array([104, 105]), false, 'base64')).toBe('aGk=')
  })

  it('truncates large binaries to MAX_CELL_CHARS', () => {
    const bigBinary = Uint8Array.from({ length: 4096 }, (_, i) => i % 256)
    const result = helpers.niceString(bigBinary, true, 'hex')

    expect(result.length).toBe(MAX_CELL_CHARS)
    // only the first bytes are needed to render a truncated cell
    expect(result.startsWith(toHex(bigBinary.subarray(0, 127)))).toBe(true)
  })

  it('truncates large wrapped buffers (mongodb style) to MAX_CELL_CHARS', () => {
    const value = { buffer: new Uint8Array(4096) }
    const result = helpers.niceString(value, true, 'hex')

    expect(result.length).toBe(MAX_CELL_CHARS)
  })

  it('does not truncate short values', () => {
    expect(helpers.niceString(new Uint8Array([1, 2]), true, 'hex')).toBe('0102')
    expect(helpers.niceString('foo', true)).toBe('foo')
  })
})

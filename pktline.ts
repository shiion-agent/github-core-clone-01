// pkt-line framing: git's smart-HTTP length-prefixed packet format.
//
// A packet is a 4-hex-digit length (counting the prefix itself) followed by
// that many bytes of payload. Length 0 is a flush packet, 1 a delimiter
// packet; both carry no payload.

/** Encode one data packet. Payloads are capped at 65516 bytes by the format. */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (body.length > 65516) throw new Error(`pkt-line payload too large: ${body.length}`);
  const length = body.length + 4;
  const prefix = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([prefix, body]);
}

/** The flush packet (`0000`): ends a packet stream section. */
export function flushPkt(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delimiter packet (`0001`): separates a v2 request's sections. */
export function delimPkt(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type Pkt =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'end' };

/** A sequential reader over a buffer of packets; throws on malformed framing. */
export class PktReader {
  #buffer: Buffer;
  #offset = 0;

  constructor(buffer: Buffer) {
    this.#buffer = buffer;
  }

  /** Bytes not yet consumed (a receive-pack's pack follows its packets). */
  get remaining(): Buffer {
    return this.#buffer.subarray(this.#offset);
  }

  get exhausted(): boolean {
    return this.#offset >= this.#buffer.length;
  }

  next(): Pkt {
    if (this.#offset >= this.#buffer.length) return { kind: 'end' };
    if (this.#offset + 4 > this.#buffer.length) throw new Error('truncated pkt-line header');
    const hex = this.#buffer.subarray(this.#offset, this.#offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`invalid pkt-line length ${JSON.stringify(hex)}`);
    const length = parseInt(hex, 16);
    if (length === 0) {
      this.#offset += 4;
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.#offset += 4;
      return { kind: 'delim' };
    }
    if (length < 4) throw new Error(`invalid pkt-line length ${length}`);
    if (this.#offset + length > this.#buffer.length) throw new Error('pkt-line overruns the body');
    const payload = this.#buffer.subarray(this.#offset + 4, this.#offset + length);
    this.#offset += length;
    return { kind: 'data', payload };
  }

  /** Every remaining data packet's payload, stopping at (and consuming) a flush or the end. */
  readUntilFlush(): Buffer[] {
    const out: Buffer[] = [];
    for (;;) {
      const packet = this.next();
      if (packet.kind === 'data') out.push(packet.payload);
      else return out;
    }
  }
}

/**
 * Wrap a payload stream in side-band-64k packets: each chunk becomes a
 * packet whose first payload byte is the band number. Band 1 is pack data,
 * band 2 progress, band 3 errors.
 */
export function sidebandWrap(data: Buffer, band = 1, chunkSize = 65515): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + chunkSize));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return Buffer.concat(parts);
}

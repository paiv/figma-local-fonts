// daemon.js
var fs = require('fs');
var url = require('url');
var http = require('http');
var querystring = require('querystring');

var VERSION = 17;

function handleRequest(request, response) {
  function acceptWithJSON(json) {
    response.writeHead(200, {
      'Access-Control-Allow-Origin': origin,
      'Content-Type': 'application/json',
    });
    response.end(JSON.stringify(json));
  }

  function acceptWithBinary(buffer) {
    response.writeHead(200, {
      'Access-Control-Allow-Origin': origin,
      'Content-Type': 'application/octet-stream',
    });
    response.end(buffer);
  }

  function ignore(comment) {
    console.log('ignoring: ' + comment);
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end();
  }

  console.log(request.method + ' ' + request.url);
  if (!fonts) {
    return ignore('ignoring request before font data is present');
  }

  // Don't expose this API to everyone
  if (request.method !== 'GET') {
    return ignore('invalid method: ' + request.method);
  }

  var requestURL = url.parse(request.url);
  if (!requestURL) {
    return ignore();
  }

  // Note: Origin can contain multiple whitespace separated origins due to
  // redirects, but that shouldn't happen for us. If it does happen, the
  // isValidOrigin check below will fail.
  var origin = request.headers.origin;
  origin = '*';

  // Whitelist certain URLs
  switch (requestURL.pathname) {
    case '/figma/version': {
      return acceptWithJSON({ version: VERSION });
    }

    case '/figma/font-files': {
      return acceptWithJSON({ version: VERSION, fontFiles: fonts });
    }

    case '/figma/update': {
      var query = querystring.parse(requestURL.query);
      if (!query || !query.version) {
        return ignore('missing version');
      }
      if (+query.version === (query.version | 0)) {
        if (+query.version > VERSION) {
          console.log('CHECK FOR UPDATES'); // The parent process is monitoring our stdout and will see this
        }
        return acceptWithJSON({ version: VERSION });
      }
      return ignore('invalid version: ' + query.version);
    }

    // Whitelist served files
    case '/figma/font-file': {
      var query = querystring.parse(requestURL.query);
      if (!query || !query.file) {
        return ignore('missing file');
      }
      if (fonts.hasOwnProperty(query.file)) {
        try {
          var buffer = fs.readFileSync(query.file);
          if (buffer.length > 0) {
            return acceptWithBinary(buffer);
          }
        } catch (e) {
        }
      }
      return ignore('invalid file: ' + query.file);
    }

    default: {
      return ignore('invalid url: ' + requestURL.pathname);
    }
  }
}

function startServer(line) {
  console.log('starting server');

  const initServer = (server, port) => {
    const listen = () => server.listen(port, 'localhost');

    server.on('error', error => {
      if (error.code === 'EADDRINUSE') {
        // Try again after a short delay.
        setTimeout(listen, 1000 * 10);
      } else {
        throw error;
      }
    });

    listen();
  };

  // HTTP for browsers that support 127.0.0.1 without triggering the mixed
  // content blocker.
  httpServer = http.createServer(handleRequest);
  initServer(httpServer, 44950);
}

var fonts = null;
var httpServer = null;

function scanfontsjs(roots) {
    // scanfonts.js
    const fs = require('fs')
    const path = require('path')
    const zlib = require('zlib')

    function parse_font_file(fn) {
        let data = fs.readFileSync(fn)
        let spec;
        switch (data.readUInt32BE(0)) {
            case 0x74746366: // ttcf
                spec = analyze_font(data, otc_reader); break
            case 0x774f4646: // wOFF
                spec = analyze_font(data, woff_reader); break
            case 0x774f4632: // wOF2
                spec = analyze_font(data, woff2_reader); break
            default:
                spec = analyze_font(data, otf_reader); break
        }
        return Array.from(spec)
    }

    function* analyze_font(data, reader) {
        const tags = new Set(['head', 'name', 'OS/2'])
        for (let section of reader(data, tags)) {
            yield extract_attributes(section)
        }
    }

    function extract_attributes(section) {
        function parse_head(data, attribs) {
            const major = data.readUInt16BE(0)
            const minor = data.readUInt16BE(2)
            if (major !== 1 || minor !== 0) {
                throw new Error(`Unsupported format version (${major},${minor})`)
            }
            const magic = data.readUInt32BE(12)
            if (magic !== 0x5F0F3CF5) {
                throw new Error(`Invalid signature ${magic}`)
            }
            const macStyle = data.readUInt16BE(44)
            attribs['italic'] = ((macStyle & 2) !== 0)
        }

        function parse_name(data, attribs) {
            const nameids = new Map([[1, 'family'], [2, 'style'], [6, 'postscript']])
            const version = data.readUInt16BE(0)
            const nrecs = data.readUInt16BE(2)
            const strings = data.readUInt16BE(4)
            for (let off = 6, i = 0; i < nrecs; ++i, off += 12) {
                const nameid = data.readUInt16BE(off+6)
                const sn = nameids.get(nameid)
                if (sn) {
                    const splat = data.readUInt16BE(off+0)
                    const sspec = data.readUInt16BE(off+2)
                    const slang = data.readUInt16BE(off+4)
                    const len = data.readUInt16BE(off+8)
                    const soff = data.readUInt16BE(off+10)
                    const s = decodeString(data.subarray(strings+soff, strings+soff+len), splat, sspec, slang)
                    if (s) {
                        attribs[sn] = s
                    }
                }
            }
        }

        function parse_OS_2(data, attribs) {
            attribs['weight'] = data.readUInt16BE(4)
            attribs['width'] = data.readUInt16BE(6)
        }

        let attribs = {}
        for (let [tag, body] of section) {
            switch (tag) {
                case 'head': parse_head(body, attribs); break
                case 'name': parse_name(body, attribs); break
                case 'OS/2': parse_OS_2(body, attribs); break
            }
        }
        return attribs
    }

    function* otc_reader(data, tags) {
        const major = data.readUInt16BE(4)
        const minor = data.readUInt16BE(6)
        if ((major !== 1 && major !== 2) || (minor !== 0)) {
            throw new Error(`Unsupported format version (${major},${minor})`)
        }
        const nfonts = data.readUInt32BE(8)
        for (let i = 0, off = 12; i < nfonts; ++i, off += 4) {
            const p = data.readUInt32BE(off)
            yield* otf_reader(data, tags, p)
        }
    }

    function* otf_reader(data, tags, tableOffset=0) {
        function* inner() {
            const sig = data.readUInt32BE(tableOffset+0)
            if (!(sig === 0x4F54544F || sig === 0x00010000 || sig === 0x74727565)) { // OTTO, 0100, true
                throw new Error(`Unsupported format ${sig}`)
            }
            const ntables = data.readUInt16BE(tableOffset+4)
            for (let i = 0, off = tableOffset+12; i < ntables; ++i, off += 16) {
                const tag = data.subarray(off, off+4).toString('utf-8')
                if (tags.has(tag)) {
                    const p = data.readUInt32BE(off+8)
                    const n = data.readUInt32BE(off+12)
                    const body = data.subarray(p, p+n)
                    yield [tag, body]
                }
            }
        }
        yield inner()
    }

    function* woff_reader(data, tags) {
        function* inner() {
            const ntables = data.readUInt16BE(12)
            for (let i = 0, off = 44; i < ntables; ++i, off += 20) {
                const tag = data.subarray(off, off+4).toString('utf-8')
                if (tags.has(tag)) {
                    const p = data.readUInt32BE(off+4)
                    const n = data.readUInt32BE(off+8)
                    const body = zlib_decompress(data.subarray(p, p+n))
                    yield [tag, body]
                }
            }
        }
        yield inner()
    }

    function* woff2_reader(data, tags) {
        const flavor = data.readUInt32BE(4)
        const ntables = data.readUInt16BE(12)
        const compressed_size = data.readUInt32BE(20)
        const known_tags = new Map([[1, 'head'], [5, 'name'], [6, 'OS/2']])
        let offsets = []
        let off = 48
        let p = 0, n
        for (let i = 0; i < ntables; ++i) {
            const flags = data[off]
            off += 1
            let tag = flags & 0x3f
            const trver = flags >> 6
            const transformed = (tag === 10 || tag === 11) ? (trver !== 3) : (trver !== 0)
            if (tag === 63) {
                tag = data.subarray(off, off+4).toString('utf8')
                off += 4
            }
            else {
                tag = known_tags.get(tag)
            }
            [n, off] = read_UIntBase128(data, off)
            if (transformed) {
                [n, off] = read_UIntBase128(data, off)
            }
            offsets.push([tag, p, n])
            p += n
        }

        let directory = [offsets]
        if (flavor === 0x74746366) { // ttcf
            off += 4
            directory = []
            let nfonts = 0;
            [nfonts, off] = read_255UInt16(data, off)
            for (let fi = 0; fi < nfonts; ++fi) {
                let ntables = 0;
                [ntables, off] = read_255UInt16(data, off)
                off += 4
                let xs = []
                for (let ti = 0; ti < ntables; ++ti) {
                    let idx = 0;
                    [idx, off] = read_255UInt16(data, off)
                    xs.push(offsets[idx])
                }
                directory.push(xs)
            }
        }

        const compressed = data.subarray(off, off+compressed_size)
        data = zlib.brotliDecompressSync(compressed)

        function* entry(offsets) {
            for (let [tag, p, n] of offsets) {
                if (tags.has(tag)) {
                    const body = data.subarray(p, p+n)
                    yield [tag, body]
                }
            }
        }

        for (let t of directory) {
            yield entry(t)
        }
    }

    function read_255UInt16(data, off) {
        let n = data[off]
        switch (n) {
            case 253:
                n = (data[off+1] << 8) | data[off+2]
                off += 3; break
            case 254:
                n = 506 + data[off+1]
                off += 2; break
            case 255:
                n = 253 + data[off+1]
                off += 2; break
            default:
                off += 1; break
        }
        return [n, off]
    }

    function read_UIntBase128(data, off) {
        for (let n = 0, i = 0; i < 5; ++i) {
            const x = data[off]
            off += 1
            n = (n << 7) | (x & 0x7f)
            if ((x & 0x80) == 0) {
                return [n, off]
            }
        }
        throw new Error('Invalid UIntBase128 value')
    }

    function zlib_decompress(data) {
        try {
            return zlib.inflateSync(data)
        }
        catch {}
        return data
    }

    function decodeString(s, platform, spec, lang) {
        switch (platform) {
            case 0: return s.toString('utf8')
            case 1:
                if (spec === 0 && lang === 0) {
                    return s.toString('utf8')
                }
                break
            case 3:
                if (spec === 1 && (lang % 256 === 9)) {
                    return s.swap16().toString('utf16le')
                }
        }
    }

    function* glob(roots, rx) {
        let fringe = [...roots]
        while (fringe.length) {
            let dir = fringe.pop()
            let subdirs;
            try {
                subdirs = fs.readdirSync(dir, {withFileTypes:true})
            } catch { continue }
            for (let f of subdirs) {
                if (f.name.match(/^\./)) { continue }
                let fullname = path.join(dir, f.name)
                if (f.isFile() && rx.test(f.name)) {
                    yield fullname
                }
                else if (f.isDirectory()) {
                    fringe.push(fullname)
                }
            }
        }
    }

    function* enumerate_fonts(roots) {
        for (let fn of glob(roots, /\.(?:ttf|ttc|otf|otc|woff2?)$/i)) {
            try {
                let spec = parse_font_file(fn)
                yield [fn, spec]
            } catch(e) { console.error(fn); console.error(e) }
        }
    }

    return Object.fromEntries(enumerate_fonts(roots))
}

var process = require('process');
let roots = process.argv.slice(2)
if (!roots.length) {
    roots = ['.']
}
fonts = scanfontsjs(roots)

startServer()

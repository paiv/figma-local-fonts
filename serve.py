#!/usr/bin/env python
import http.server
import json
import re
import socketserver
import struct
import sys
import traceback
import zlib
from pathlib import Path
from urllib.parse import urlsplit, parse_qs


VERSION = 17
BIND_PORT = 44950
FONTS = None


class RequestHandler (http.server.BaseHTTPRequestHandler):

    def _accept_json(self, obj):
        s = json.dumps(obj, separators=',:').encode('utf-8')
        self._accept(s, 'application/json')

    def _accept_binary(self, data):
        self._accept(data, 'application/octet-stream')

    def _accept(self, data, content_type):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', len(data))
        self.end_headers()
        self.wfile.write(data)

    def _ignore(self, comment):
        print(f'ignoring: {comment}', file=sys.stderr)
        self.send_response(404)
        self.send_header('Content-Type', 'text/plain')
        self.end_headers()

    def do_GET(self):
        _,_,path,query,_ = urlsplit(self.path)

        if path == '/figma/version':
            self._accept_json({'version': VERSION})

        elif path == '/figma/font-files':
            self._accept_json({'version': VERSION, 'fontFiles': FONTS})

        elif path == '/figma/update':
            params = parse_qs(query)
            ver = params.get('version')
            if ver is None:
                self._ignore('missing version')
            else:
                try:
                    ver, = ver
                    v = float(ver)
                    if v > VERSION:
                        print('CHECK FOR UPDATES', file=sys.stderr)
                    self._accept_json({'version': VERSION})
                except (TypeError, ValueError):
                    self._ignore(f'invalid version: {ver}')

        elif path == '/figma/font-file':
            params = parse_qs(query)
            file = params.get('file')
            if file is None:
                self._ignore('missing file')
            try:
                file, = file
                if file in FONTS:
                    with open(file, 'rb') as fp:
                        data = fp.read()
                    self._accept_binary(data)
                    return
            except:
                print(repr(file), file=sys.stderr)
                traceback.print_exc()
            self._ignore(f'invalid file: {file}')

        else:
            self._ignore(f'invalid url: {self.path}')


def parse_font_file(fn):
    with open(fn, 'rb') as fp:
        data = fp.read()
    sig = data[:4]
    if sig == b'ttcf':
        spec = analyze_font(data, otc_reader)
    elif sig == b'wOFF':
        spec = analyze_font(data, woff_reader)
    elif sig == b'wOF2':
        spec = analyze_font(data, woff2_reader)
    else:
        spec = analyze_font(data, otf_reader)
    return list(spec)


def analyze_font(data, reader):
    for section in reader(data, [b'head', b'name', b'OS/2']):
        yield extract_attributes(section)


def extract_attributes(section):
    attribs = dict()
    for tag, body in section:

        if tag == b'head':
            major, minor = struct.unpack('>HH', body[:4])
            if not ((major == 1) and (minor == 0)):
                raise Exception(f'Unsupported format version {(major, minor)}')

            sig, = struct.unpack('>I', body[12:16])
            if sig != 0x5F0F3CF5:
                raise Exception(f'Invalid signature {sig:08X}')

            mac_style, = struct.unpack('>H', body[44:46])
            italic = (mac_style & 2) != 0
            attribs['italic'] = italic

        elif tag == b'name':
            nameids = {1: 'family', 2: 'style', 6: 'postscript'}
            version, nrecs, table = struct.unpack('>HHH', body[:6])
            for i in range(nrecs):
                off = 6 + i * 12
                splat, sspec, slang, nameid, slen, soff = struct.unpack('>HHHHHH', body[off:off+12])
                soff += table
                sn = nameids.get(nameid)
                if sn:
                    s = decode_string(body[soff:soff+slen], splat, sspec, slang)
                    if s:
                        attribs[sn] = s

        elif tag == b'OS/2':
            weight, width = struct.unpack('>HH', body[4:8])
            attribs['weight'] = weight
            attribs['width'] = width

    return attribs


def otc_reader(data, tags):
    major, minor, nfonts = struct.unpack('>HHI', data[4:12])
    if not ((major == 1 or major == 2) and (minor == 0)):
        raise Exception(f'Unsupported format version {(major, minor)}')
    for i in range(nfonts):
        off = 12 + i * 4
        p, = struct.unpack('>I', data[off:off+4])
        yield from otf_reader(data, tags, p)


def otf_reader(data, tags, table_offset=0):
    def inner():
        off = table_offset + 0
        sig = data[off:off+4]
        if sig not in (b'OTTO', b'\x00\x01\x00\x00', b'true'):
            raise Exception(f'Unsupported format {sig}')

        off = table_offset + 4
        ntables, = struct.unpack('>H', data[off:off+2])
        for i in range(ntables):
            off = table_offset + 12 + i * 16
            tag = data[off:off+4]
            if tag in tags:
                p,n = struct.unpack('>II', data[off+8:off+16])
                body = data[p:p+n]
                yield (tag, body)

    yield inner()


def woff_reader(data, tags):
    def inner():
        ntables, = struct.unpack('>H', data[12:14])
        for i in range(ntables):
            off = 44 + i * 20
            tag = data[off:off+4]
            if tag in tags:
                p,n = struct.unpack('>II', data[off+4:off+12])
                body = zlib_decompress(data[p:p+n])
                yield (tag, body)

    yield inner()


def woff2_reader(data, tags):
    import brotli
    flavor = data[4:8]
    ntables, = struct.unpack('>H', data[12:14])
    compressed_size, = struct.unpack('>I', data[20:24])
    known_tags = {1: b'head', 5: b'name', 6: b'OS/2'}
    offsets = list()
    off = 48
    p = 0
    for i in range(ntables):
        flags = data[off]
        off += 1
        tag = flags & 0x3f
        trver = flags >> 6
        transformed = (trver != 3) if (tag == 10 or tag == 11) else (trver != 0)
        if tag == 63:
            stag = data[off:off+4]
            off += 4
        else:
            stag = known_tags.get(tag)
        n, off = read_UIntBase128(data, off)
        if transformed:
            n, off = read_UIntBase128(data, off)
        offsets.append((stag, p, n))
        p += n

    directory = [offsets]
    if flavor == b'ttcf':
        off += 4
        directory = list()
        nfonts, off = read_255UInt16(data, off)
        for _ in range(nfonts):
            ntables, off = read_255UInt16(data, off)
            flavor = data[off:off+4]
            off += 4
            xs = list()
            for _ in range(ntables):
                idx, off = read_255UInt16(data, off)
                xs.append(offsets[idx])
            directory.append(xs)

    compressed = data[off:off+compressed_size]
    data = brotli.decompress(compressed)

    def entry(offsets):
        for tag, p, n in offsets:
            if tag in tags:
                body = data[p:p+n]
                yield (tag, body)

    for t in directory:
        yield entry(t)


def read_255UInt16(data, off):
    x = data[off]
    n = x
    if x == 253:
        n = (data[off+1] << 8) | data[off+2]
        off += 3
    elif x == 254:
        n = 506 + data[off+1]
        off += 2
    elif x == 255:
        n = 253 + data[off+1]
        off += 2
    else:
        off += 1
    return n, off


def read_UIntBase128(data, off):
    n = 0
    for _ in range(5):
        x = data[off]
        off += 1
        n = (n << 7) | (x & 0x7f)
        if not (x & 0x80):
            return n, off
    raise Exception('Invalid UIntBase128 value')


def zlib_decompress(data):
    try:
        return zlib.decompress(data)
    except zlib.error:
        pass
    return data


def decode_string(s, platform, spec, lang):
    if platform == 0:
        return s.decode('utf-8')
    elif platform == 1:
        if spec == 0 and lang == 0:
            return s.decode('utf-8')
    elif platform == 3:
        if spec == 1 and (lang % 256) == 9:
            return s.decode('utf-16be')


def scan_fonts(roots):
    def glob(roots, rx):
        fringe = [Path(s) for s in roots]
        while fringe:
            d = fringe.pop()
            for fn in d.iterdir():
                if fn.name.startswith('.'): continue
                if fn.is_file() and rx.search(fn.name):
                    yield fn
                elif fn.is_dir():
                    fringe.append(fn)

    def enumerate_fonts(roots):
        rx = re.compile(r'\.(ttf|ttc|otf|otc|woff2?)$', re.I)
        for fn in glob(roots, rx):
            try:
                spec = parse_font_file(fn)
                yield [str(fn), spec]
            except:
                print(fn, file=sys.stderr)
                traceback.print_exc()

    return dict(enumerate_fonts(roots))


def start_server():
    with socketserver.TCPServer(('localhost', BIND_PORT), RequestHandler) as httpd:
        print('starting server')
        httpd.serve_forever()


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Serve local fonts to Figma.')
    parser.add_argument('roots', metavar='dir', nargs='*', default=['.'], help='a directory with font files')
    args = parser.parse_args()

    FONTS = scan_fonts(args.roots)
    start_server()

'use strict';
const common = require('../common.js');
const http = require('http');

const bench = common.createBenchmark(main, {
  // Unicode confuses ab on os x.
  c: [50, 500],
  n: [0, 5, 20]
});

function main({ c, n }) {
  const server = http.createServer((req, res) => {
    res.end();
  });

  server.listen(common.PORT, () => {
    const headers = {
      'Content-Type': 'text/plain',
      'Accept': 'text/plain',
      'User-Agent': 'nodejs-benchmark',
      'Date': new Date().toString(),
      'Cache-Control': 'no-cache'
    };
    for (let i = 0; i < n; i++) {
      headers[`foo${i}`] = `some header value ${i}`;
    }
    bench.http({
      path: '/',
      connections: c,
      headers
    }, () => {
      server.close();
    });
  });
}

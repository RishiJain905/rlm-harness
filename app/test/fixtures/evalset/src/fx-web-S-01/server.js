// Serves this folder on EVAL_PROJECT_PORT (default 3211), with no dependencies.
const http = require('http')
const fs = require('fs')
const path = require('path')

const PORT = Number(process.env.EVAL_PROJECT_PORT || 3211)
const ROOT = __dirname
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

http
  .createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0])
    const file = path.join(ROOT, url === '/' ? 'index.html' : url)
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  .listen(PORT, '127.0.0.1')

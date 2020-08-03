const glob = require('glob')
const path = require('path')
const fs = require('fs')
const axios = require('axios')
const http = require('http')


module.exports = class {
  constructor() {

  }

  apply(compiler) {
    compiler.hooks.done.tap('MyPlugin', function (e) {
      console.log('------------');
      console.log('MyPlugin');
      console.log('------------');
      const _path = e.compilation.options.output.path
      const list = glob.sync(path.join(_path, './**/*.{js.map,}'))
      list.forEach(i => {
        console.log(i);
        const s = fs.readFileSync(i)

        let option = {
          host: '127.0.0.1',   //请求host
          path: "/file",  //请求链接
          port: 7001,            //端口
          method: "POST",  //请求类型
          headers: {   //请求头
            'Content-Type': 'application/octet-stream',  //数据格式为二进制数据流
            'Transfer-Encoding': 'chunked',  //传输方式为分片传输
            'Connection': 'keep-alive'    //这个比较重要为保持链接。
          }
        }
        let req = http.request(option);
        req.write(s);  //发送数据
        req.end();   //

        // fs.createReadStream(path.join(__dirname, "line.png"))
        //   .on("open", chunk => {
        //   })
        //   .on("data", chunk => {
        //     req.write(chunk);  //发送数据
        //   })
        //   .on("end", () => {
        //     req.end();   //发送结束
        //   })

        // fs.unlinkSync(i);
      })
    })
  }
}


function send() {
  console.log('----my---')
  let a = '/Users/lynn/Documents/www/lynn/log/dist/js/app.8869bc4e.js.map'
  const s = fs.readFileSync(a)
  console.log(s);

  let option = {
    host: '127.0.0.1',   //请求host
    path: "/file",  //请求链接
    port: 7001,            //端口
    method: "POST",  //请求类型
    headers: {   //请求头
      'Content-Type': 'application/octet-stream',  //数据格式为二进制数据流
      'Transfer-Encoding': 'chunked',  //传输方式为分片传输
      'Connection': 'keep-alive'    //这个比较重要为保持链接。
    }
  }
  let req = http.request(option);
  req.write(s);  //发送数据
  req.end();
}

send()

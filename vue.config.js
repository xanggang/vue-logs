
const uploadSourceMapWebPlugin = require('./src/tool')

// 配置信息在这里
module.exports = {
  configureWebpack: {
    plugins: [
      new uploadSourceMapWebPlugin({
        uploadUrl: 'http://127.0.0.1:7001/upload/map'
      })
    ]
  },
}

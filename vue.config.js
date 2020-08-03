const webpack = require('webpack')
const tool = require('./src/tool')

// 配置信息在这里
module.exports = {
  filenameHashing: true, // 是否使用md5码
  lintOnSave: true, // eslint 错误处理，true表示对待eslint错误为warning，warning不会导致编译失败
  integrity: false, // 内容安全策略及子资源完整性
  configureWebpack: {
    plugins: [
      new tool()
    ]
  },
}

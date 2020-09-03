import axios from 'axios'

function log(title: any) {
  return function log(target: Object, key: any, descriptor: PropertyDescriptor) {
    const oldFun = descriptor.value
    descriptor.value = function (data: any) {
      console.log(title);
      console.log(data);
      oldFun(data)
    }
  }
}



 class Api {

  @log('测试')
  sendMessage(data: any) {
    axios.get('http://127.0.0.1:7001/api', data)
  }
}

export default new Api()

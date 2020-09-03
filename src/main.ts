import Vue from 'vue'
import App from './App.vue'
// import LogSdk from './log'
// import Raven from "raven-js";
// import axios from 'axios'
import TraceKit from 'tracekit'
import GlobalError from './sdk/global'
import traceKit from "tracekit";

Vue.config.productionTip = false

const vue = new Vue({
  render: (h) => h(App),
}).$mount('#app')

new GlobalError(Vue)

// @ts-ignore
import RavenVue from 'raven-js/plugins/vue'
//
// Raven
//   .config('https://08dc77f2b5dd42e490be150ad705ddd@sentry.io/123456')
//   .addPlugin(RavenVue, Vue)
//   .install()

  // .config('http://127.0.0.1:7001/file')
// Raven.setTransport(function(option){
//   axios.post('http://127.0.0.1:7001/api/upload/store',{ appName: 'log', ...option.data})
//   option.onSuccess();
// });


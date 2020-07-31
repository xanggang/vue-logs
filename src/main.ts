import Vue from 'vue';
import App from './App.vue';
import * as Sentry from '@sentry/browser'
import { Vue as VueIntegration } from '@sentry/integrations';
import LogSdk from './log'
// Sentry.init({
//   dsn: 'https://5c3ab093004246f69cb40ffe690c3413@o422336.ingest.sentry.io/5347833',
//   integrations: [new VueIntegration({ Vue, attachProps: true })]
// })

Vue.config.productionTip = false;

new Vue({
  render: (h) => h(App),
}).$mount('#app');

Vue.config.errorHandler = function (err, vm, info) {
  console.log(err);
  console.log(vm);
  console.log(info);
}

window.onerror = function(...e) {
  console.log(e);
}

new LogSdk()



// Promise.reject('124')
throw new Error('as3')


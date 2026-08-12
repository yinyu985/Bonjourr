// 网络不可达（离线、DNS 失败、超时）与真正的同步错误分开分类：
// 启动自动同步遇到断网只需静默跳过，不该以 console.warn 出现在
// chrome://extensions 的错误面板里。
export class SyncNetworkError extends Error {}

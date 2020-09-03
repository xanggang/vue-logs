import UA from 'ua-device'

export default function () {
  if (!(window.navigator && window.navigator.userAgent)) {
    return {}
  }

  let userAgent = window.navigator.userAgent
  const device = new UA(userAgent)
  const system = device?.os?.name
  const system_version = device?.os?.version?.original
  const browser_type = device?.browser?.channel
  const browser_name = device?.browser?.name
  const browser_version = device?.browser?.version?.original
  const browser_core = device?.engine?.name

  return {
    system,
    system_version,
    browser_type,
    browser_name,
    browser_version,
    browser_core
  }
}

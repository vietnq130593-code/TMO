import * as React from "react"

const MOBILE_BREAKPOINT = 768

// Subscribe theo chuẩn useSyncExternalStore: matchMedia change event báo hiệu
// viewport đã vượt/ngược ngưỡng mobile — khi đó React đọc lại snapshot.
function subscribe(callback: () => void) {
  const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
  mql.addEventListener("change", callback)
  return () => mql.removeEventListener("change", callback)
}

export function useIsMobile() {
  // SSR/client lần đầu render: false (khớp hành vi cũ — isMobile undefined → !!undefined = false)
  return React.useSyncExternalStore(
    subscribe,
    () => window.innerWidth < MOBILE_BREAKPOINT,
    () => false
  )
}

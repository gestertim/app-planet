export const relationshipRefreshEvent = "app-planet:relationship-refresh";

// 事件僅要求重新讀取；不以事件來源或上一項操作的回應認定關係。
export const productFetch: typeof globalThis.fetch = async (...args) => {
  const response = await globalThis.fetch(...args);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(relationshipRefreshEvent));
  return response;
};

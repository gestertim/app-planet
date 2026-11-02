// 隔離 Vite 宿主只驗證保存流程；實際路由導覽由 Next HTTPS browser 測試驗收。
export function useRouter() {
  return {
    push(href: string): never {
      throw new Error(`Vite 測試宿主不支援 App Router 導覽：${href}`);
    },
  };
}

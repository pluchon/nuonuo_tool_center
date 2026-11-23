// 退出动画会暂时保留弹窗元素；遮罩开始允许点击背景时，背景快捷键也应恢复。
export function hasInteractiveModal(): boolean {
  return [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')]
    .some((dialog) => getComputedStyle(dialog).pointerEvents !== 'none')
}

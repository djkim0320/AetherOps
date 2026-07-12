export function assertChatLayout(layout, label) {
  const failures = [];
  if (layout.desktopGate) failures.push(`${label}: desktop-required gate was shown at a supported viewport`);
  if (layout.horizontalOverflow) failures.push(`${label}: page has horizontal overflow`);
  if (!layout.chatHeading) failures.push(`${label}: chat route did not render`);
  if (!layout.rail || !layout.workspace || !layout.inspector || !layout.runBar) {
    failures.push(`${label}: expected rail, workspace, run bar, and inspector`);
    return failures;
  }
  if (Math.abs(layout.rail.width - 272) > 3) failures.push(`${label}: expanded rail width is ${layout.rail.width}px, expected 272px`);
  if (Math.abs(layout.inspector.width - 360) > 3) failures.push(`${label}: inspector width is ${layout.inspector.width}px, expected 360px`);
  if (layout.rail.right > layout.workspace.x + 1) failures.push(`${label}: rail overlaps workspace`);
  if (layout.workspace.right > layout.inspector.x + 1) failures.push(`${label}: workspace overlaps inspector`);
  if (layout.runBar.width < 300 || layout.runBar.height > 60) failures.push(`${label}: compact run bar geometry is invalid`);
  if (layout.inspectorTabs.length !== 3) failures.push(`${label}: inspector does not expose exactly three tabs`);
  return failures;
}

export function assertTheme(layout, expected, label) {
  return layout.theme === expected ? [] : [`${label}: theme is ${layout.theme ?? "unset"}, expected ${expected}`];
}

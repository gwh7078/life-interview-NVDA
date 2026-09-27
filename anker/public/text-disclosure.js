const DEFAULT_COLLAPSED_CLASS = 'is-collapsed';
const DEFAULT_COLLAPSED_LABEL = '展开全文';
const DEFAULT_EXPANDED_LABEL = '收起';

function setDisclosureState({ content, toggle, collapsedClass, expandedLabel, collapsedLabel }, expanded) {
  content.classList.toggle(collapsedClass, !expanded);
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.textContent = expanded ? expandedLabel : collapsedLabel;
}

export function createTextDisclosure({
  content,
  toggle,
  collapsedClass = DEFAULT_COLLAPSED_CLASS,
  collapsedLabel = DEFAULT_COLLAPSED_LABEL,
  expandedLabel = DEFAULT_EXPANDED_LABEL,
} = {}) {
  if (!content || !toggle) {
    return { refresh: () => false, setExpanded: () => {} };
  }

  let expanded = false;
  const config = { content, toggle, collapsedClass, expandedLabel, collapsedLabel };

  function reset() {
    expanded = false;
    toggle.hidden = true;
    setDisclosureState(config, false);
    content.classList.remove(collapsedClass);
  }

  function refresh() {
    if (!String(content.textContent || '').trim()) {
      reset();
      return false;
    }

    const wasExpanded = expanded;
    content.classList.remove(collapsedClass);
    const fullHeight = content.scrollHeight;
    content.classList.add(collapsedClass);
    const collapsedHeight = content.clientHeight;
    const overflowing = fullHeight > collapsedHeight + 1;

    if (!overflowing) {
      reset();
      return false;
    }

    expanded = wasExpanded;
    toggle.hidden = false;
    setDisclosureState(config, expanded);
    return true;
  }

  function setExpanded(nextExpanded) {
    if (toggle.hidden && nextExpanded) return;
    expanded = Boolean(nextExpanded);
    setDisclosureState(config, expanded);
  }

  toggle.addEventListener('click', () => setExpanded(!expanded));
  refresh();

  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(refresh);
    observer.observe(content);
  } else if (typeof window !== 'undefined') {
    window.addEventListener('resize', refresh, { passive: true });
  }

  return { refresh, setExpanded };
}

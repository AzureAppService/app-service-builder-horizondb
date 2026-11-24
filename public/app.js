'use strict';

const form = document.querySelector('#search-form');
const input = document.querySelector('#query');
const submit = form.querySelector('button[type="submit"]');
const announcement = document.querySelector('#announcement');
const panels = {
  keyword: document.querySelector('#keyword-results'),
  hybrid: document.querySelector('#hybrid-results')
};
let activeRequest;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function emptyState(title, message, isError = false) {
  const container = element('div', `empty-state${isError ? ' error-state' : ''}`);
  const icon = element('span', 'empty-icon', isError ? '!' : '\u2315');
  icon.setAttribute('aria-hidden', 'true');
  container.append(icon, element('h4', '', title), element('p', '', message));
  return container;
}

function loading(panel) {
  panel.replaceChildren();
  panel.setAttribute('aria-busy', 'true');
  const label = element('p', 'result-meta', 'Searching the guide collection...');
  const first = element('div', 'skeleton');
  const second = element('div', 'skeleton');
  first.setAttribute('aria-hidden', 'true');
  second.setAttribute('aria-hidden', 'true');
  panel.append(label, first, second);
}

function matchLabel(type) {
  if (type === 'fulltext') return ['Keyword', 'keyword'];
  if (type === 'vector') return ['Semantic', 'semantic'];
  if (type === 'vector+fulltext') return ['Keyword + semantic', 'both'];
  return ['Match type unavailable', 'unknown'];
}

function guideCard(guide) {
  const card = element('article', 'guide-card');
  const top = element('div', 'guide-topline');
  const [label, kind] = matchLabel(guide.matchType);
  top.append(
    element('span', 'guide-code', guide.code || 'Guide'),
    element('span', 'guide-category', guide.category || ''),
    element('span', `match-badge ${kind}`, label)
  );
  const bottom = element('div', 'guide-bottom');
  const details = document.createElement('details');
  details.append(element('summary', '', 'View troubleshooting steps'));
  const steps = document.createElement('ol');
  if (Array.isArray(guide.steps)) {
    for (const step of guide.steps) steps.append(element('li', '', String(step)));
  }
  if (!steps.children.length) steps.append(element('li', '', 'No steps are available for this guide.'));
  details.append(steps);
  bottom.append(details);
  if (guide.score !== null && guide.score !== undefined && Number.isFinite(Number(guide.score))) {
    const score = element('span', 'guide-score', `Score ${Number(guide.score).toFixed(3)}`);
    score.title = 'Higher is better within this list. Scores are not comparable across modes.';
    bottom.append(score);
  }
  card.append(top, element('h4', '', guide.title || 'Untitled guide'),
    element('p', '', guide.summary || ''), bottom);
  return card;
}

function renderMode(name, result) {
  const panel = panels[name];
  panel.removeAttribute('aria-busy');
  panel.replaceChildren();
  if (!result || result.status !== 'ok' || !Array.isArray(result.results)) {
    panel.append(emptyState('Search unavailable',
      result?.message || 'The server did not return a usable result. Please try again.', true));
    return 0;
  }
  const guides = result.results;
  if (!guides.length) {
    panel.append(emptyState('No matches this time', 'Try an error code or a different description.'));
    return 0;
  }
  const meta = element('div', 'result-meta');
  meta.append(element('strong', '', `${guides.length} ${guides.length === 1 ? 'guide' : 'guides'}`));
  if (Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0) {
    meta.append(element('span', '', `${result.elapsedMs} ms database query`));
  }
  panel.append(meta);
  for (const guide of guides) panel.append(guideCard(guide));

  if (name === 'hybrid') {
    const hasKeyword = guides.some((guide) => ['fulltext', 'vector+fulltext'].includes(guide.matchType));
    const hasSemantic = guides.some((guide) => ['vector', 'vector+fulltext'].includes(guide.matchType));
    const both = hasKeyword && hasSemantic;
    const message = both
      ? 'Returned guides include both keyword and semantic contributions.'
      : 'Returned guides do not show both contributions. This alone does not prove whether the other path ran.';
    panel.append(element('p', `observed-note${both ? '' : ' warning'}`, message));
  }
  return guides.length;
}

function showRequestError(message) {
  for (const panel of Object.values(panels)) {
    panel.removeAttribute('aria-busy');
    panel.replaceChildren(emptyState('Search unavailable', message, true));
  }
  announcement.textContent = message;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = input.value.trim();
  if (!query || query.length > 180 || /[\u0000-\u001f\u007f]/.test(query)) {
    input.setCustomValidity('Enter a search of 1-180 characters without control characters.');
    input.reportValidity();
    return;
  }
  input.setCustomValidity('');
  if (activeRequest) activeRequest.abort();
  const controller = new AbortController();
  activeRequest = controller;
  for (const panel of Object.values(panels)) loading(panel);
  submit.disabled = true;
  announcement.textContent = 'Searching keyword and hybrid matches.';

  try {
    const response = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: controller.signal
    });
    const result = await response.json();
    if (result.keyword || result.hybrid) {
      const keywordCount = renderMode('keyword', result.keyword);
      const hybridCount = renderMode('hybrid', result.hybrid);
      const failed = [result.keyword, result.hybrid].filter((mode) => mode?.status !== 'ok').length;
      announcement.textContent = failed
        ? `Search finished with ${failed} unavailable ${failed === 1 ? 'mode' : 'modes'}.`
        : `Search finished. ${keywordCount} keyword and ${hybridCount} hybrid guides found.`;
    } else {
      showRequestError(result.error || `Search failed with status ${response.status}.`);
    }
  } catch (error) {
    if (error.name !== 'AbortError') {
      showRequestError('The search could not be completed. Check your connection and try again.');
    }
  } finally {
    if (activeRequest === controller) {
      activeRequest = undefined;
      submit.disabled = false;
    }
  }
});

input.addEventListener('input', () => input.setCustomValidity(''));
document.querySelectorAll('[data-example]').forEach((button) => {
  button.addEventListener('click', () => {
    input.value = button.dataset.example;
    input.setCustomValidity('');
    form.requestSubmit();
  });
});

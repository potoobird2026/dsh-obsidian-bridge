/**
 * 关键词提取与知识库检索。
 *
 * 置信度算法严格遵循 PRD §5.3.3；唯一的实现差异是关键词"命中"采用
 * OR 语义（任一关键词出现即算命中），以提升知识注入命中率。
 */

/** 参与检索的正文截断长度，避免超长笔记拖慢匹配。 */
const BODY_MATCH_LIMIT = 20000;

/**
 * 从 prompt 中提取关键词。
 *
 * 按空白与中英文标点切分，过滤掉过短的词，取前 5 个。
 * @param prompt - 原始 prompt 文本。
 * @param minLength - 参与提取的最短词长。
 * @returns 关键词数组。
 */
export function extractKeywords(prompt, minLength = 2) {
  if (typeof prompt !== 'string' || prompt.length === 0) return [];
  const parts = prompt.split(/[\s,，。！？、；：""''（）【】《》〈〉「」『』\-\u00b7]+\s*/);
  const seen = new Set();
  const keywords = [];
  for (const part of parts) {
    const word = part.trim();
    if (word.length < minLength) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    keywords.push(word);
    if (keywords.length >= 5) break;
  }
  return keywords;
}

/**
 * 判断正文是否命中关键词集合。
 * @param searchText - 已小写化的检索文本。
 * @param keywords - 关键词数组。
 * @returns 命中的关键词数量。
 */
function countKeywordHits(searchText, keywords) {
  let hits = 0;
  for (const keyword of keywords) {
    if (searchText.includes(String(keyword).toLowerCase())) hits += 1;
  }
  return hits;
}

/**
 * 在内存索引上执行检索。
 * @param index - `buildVaultIndex` 产出的索引。
 * @param options - 检索条件。
 * @returns 按置信度降序的结果集。
 */
export function queryIndex(index, options = {}) {
  const {
    keywords = [],
    tags = [],
    category = '',
    timeRange = '',
    project = '',
    agent = '',
    permission = '',
    limit = 5,
  } = options;

  const keywordList = Array.isArray(keywords) ? keywords : [];
  const results = [];

  for (const entry of index) {
    const searchText = `${entry.title} ${entry.summary} ${entry.body.substring(0, BODY_MATCH_LIMIT)}`.toLowerCase();

    if (keywordList.length > 0 && countKeywordHits(searchText, keywordList) === 0) continue;
    if (tags.length > 0 && !tags.some((tag) => entry.tags.includes(tag))) continue;
    if (category && entry.category !== category) continue;
    if (timeRange) {
      const entryDate = entry.created || entry.updated || '';
      if (!entryDate || !String(entryDate).startsWith(timeRange)) continue;
    }
    if (project && !String(entry.project).toLowerCase().includes(String(project).toLowerCase())) continue;
    if (permission && entry.permission?.scope !== permission) continue;
    if (agent && entry.permission?.agent !== agent) continue;

    // PRD §5.3.3 置信度算法
    let confidence = 0;
    if (keywordList.length > 0 && countKeywordHits(searchText, keywordList) > 0) confidence += 0.5;
    if (tags.length > 0 && tags.some((tag) => entry.tags.includes(tag))) confidence += 0.3;
    if (entry.title) confidence += 0.1;
    if (entry.summary) confidence += 0.1;
    confidence = Math.min(confidence, 1.0);

    results.push({
      path: entry.path,
      title: entry.title,
      summary: entry.summary,
      tags: entry.tags,
      category: entry.category,
      created: entry.created,
      updated: entry.updated,
      confidence: Math.round(confidence * 100) / 100,
      source: entry.source,
      permission: entry.permission,
    });
  }

  results.sort((left, right) => right.confidence - left.confidence);
  return results.slice(0, limit);
}

/**
 * 把检索结果格式化为模型可读的上下文（PRD §5.3.5）。
 * @param results - `queryIndex` 的结果集。
 * @returns Markdown 文本；无结果时为空串。
 */
export function formatKnowledgeContext(results) {
  if (!results || results.length === 0) return '';
  const lines = ['## 知识库相关笔记（自动注入）\n'];
  for (const result of results) {
    lines.push(`### [${result.title}]`);
    lines.push(`- 来源: ${result.path}`);
    lines.push(`- 分类: ${result.category} | 置信度: ${result.confidence}`);
    lines.push(`- 更新: ${result.updated || result.created || '未知'}`);
    lines.push(`- 摘要: ${result.summary}`);
    lines.push('');
  }
  return lines.join('\n');
}

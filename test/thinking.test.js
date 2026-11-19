import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/policy.js';
import { bodyOptions, protocol } from '../src/providers.js';

const mapped = (provider, model, thinking) => {
  const config = validateConfig({ provider, model, thinking });
  return bodyOptions(config, protocol(config));
};

test('unified thinking preserves the requested effort and maps off by protocol', () => {
  for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.deepEqual(mapped('deepseek', 'test', effort), {
      thinking: { type: 'enabled' }, reasoning_effort: effort,
    });
    assert.deepEqual(mapped('mimo', 'test', effort), {
      thinking: { type: 'enabled' }, reasoning_effort: effort,
    });
    assert.deepEqual(mapped('bailian', 'test', effort), {
      enable_thinking: true, reasoning_effort: effort,
    });
    assert.deepEqual(mapped('opencode', 'gpt-test', effort), { reasoning: { effort } });
    if (!['xhigh', 'max'].includes(effort))
      assert.deepEqual(mapped('opencode', 'gemini-4-argon', effort), {
        generationConfig: { thinkingConfig: { thinkingLevel: effort, includeThoughts: true } },
      });
    if (effort !== 'minimal')
      assert.deepEqual(mapped('opencode', 'claude-test', effort), {
        thinking: { type: 'adaptive' }, output_config: { effort },
      });
  }
  assert.deepEqual(mapped('deepseek', 'test', 'off'), { thinking: { type: 'disabled' } });
  assert.deepEqual(mapped('mimo', 'test', 'off'), { thinking: { type: 'disabled' } });
  assert.deepEqual(mapped('bailian', 'test', 'off'), { enable_thinking: false });
  assert.deepEqual(mapped('opencode', 'gpt-test', 'off'), { reasoning: { effort: 'none' } });
  assert.deepEqual(mapped('opencode', 'claude-test', 'off'), { thinking: { type: 'disabled' } });
  assert.deepEqual(mapped('opencode', 'gemini-test', 'off'), {
    generationConfig: { thinkingConfig: { thinkingBudget: 0, includeThoughts: false } },
  });
  assert.deepEqual(mapped('opencode', 'gemini-test', undefined), {});
});

test('old thinking configurations remain valid; invalid or unmappable efforts fail', () => {
  assert.deepEqual(mapped('opencode', 'claude-test', { enabled: true, budget: 2048 }), {
    thinking: { type: 'enabled', budget_tokens: 2048 },
  });
  assert.deepEqual(mapped('opencode', 'gemini-test', { enabled: true, budget: 2048 }), {
    generationConfig: { thinkingConfig: { thinkingBudget: 2048, includeThoughts: true } },
  });
  assert.deepEqual(mapped('opencode', 'gemini-test', { enabled: true, effort: 'low' }),
                   mapped('opencode', 'gemini-test', 'low'));
  for (const value of ['on', 'LOW', '', null, true, 1, [], { enabled: true, effort: 'bad' }])
    assert.throws(() => mapped('opencode', 'gemini-test', value), /thinking/);
  for (const value of ['xhigh', 'max', { enabled: true, effort: 'low', budget: 2048 }])
    assert.throws(() => mapped('opencode', 'gemini-test', value), /Google/);
  assert.throws(() => mapped('opencode', 'claude-test', 'minimal'), /Anthropic/);
  assert.throws(() => mapped('opencode', 'claude-test', { enabled: true, effort: 'low', budget: 2048 }), /Anthropic/);
  const config = { provider: 'opencode', model: 'gemini-test', thinking: 'low' };
  validateConfig(config);
  bodyOptions(config, protocol(config));
  assert.equal(config.thinking, 'low'); // Validation/mapping must not mutate saved configs.
});

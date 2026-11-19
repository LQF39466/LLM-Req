import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { validateConfig } from '../src/policy.js';
import { bodyOptions, invoke, protocol } from '../src/providers.js';

test('DeepSeek official provider uses its chat endpoint, key and non-thinking mode', async () => {
  const config = validateConfig({provider:'deepseek',model:'deepseek-flash',thinking:'off'});
  assert.equal(protocol(config), 'chat');
  assert.deepEqual(bodyOptions(config, 'chat'), {thinking:{type:'disabled'}});
  let received;
  const upstream = createServer(async (req,res) => {
    let raw=''; for await (const chunk of req) raw+=chunk;
    received={path:req.url,auth:req.headers.authorization,body:JSON.parse(raw)};
    res.writeHead(200, {'content-type':'text/event-stream'});
    for (const event of [
      {id:'fixture',object:'chat.completion.chunk',created:1,model:'deepseek-flash',choices:[{index:0,delta:{content:'4'},finish_reason:null}]},
      {id:'fixture',object:'chat.completion.chunk',created:1,model:'deepseek-flash',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:1,total_tokens:6}},
    ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  upstream.listen(0,'127.0.0.1'); await once(upstream,'listening');
  const oldKey=process.env.DEEPSEEK_API_KEY, oldBase=process.env.DEEPSEEK_BASE_URL;
  process.env.DEEPSEEK_API_KEY='fixture-deepseek-key';
  process.env.DEEPSEEK_BASE_URL=`http://127.0.0.1:${upstream.address().port}/v1`;
  try {
    const response=await invoke(config,{prompt:'2 + 2?'});
    assert.equal(response.partial,'4');
    assert.equal(received.path,'/v1/chat/completions');
    assert.equal(received.auth,'Bearer fixture-deepseek-key');
    assert.equal(received.body.model,'deepseek-flash');
    assert.deepEqual(received.body.thinking,{type:'disabled'});
    assert.equal(response.usage.outputTokens,1);
  } finally {
    if(oldKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY=oldKey;
    if(oldBase === undefined) delete process.env.DEEPSEEK_BASE_URL; else process.env.DEEPSEEK_BASE_URL=oldBase;
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
});

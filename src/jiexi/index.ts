import sourceMap, { SourceMapConsumer } from 'source-map'
// @ts-ignore
import rawSourceMapJsonData1 from '../../dist/js/chunk-vendors.e5a9d668.json'
// @ts-ignore
import rawSourceMapJsonData2 from '../log'

// @ts-ignore
SourceMapConsumer.initialize({
  'lib/mappings.wasm': 'https://unpkg.com/source-map@0.7.3/lib/mappings.wasm',
});

// @ts-ignore
const sourceMapDeal = async (rawSourceMap, line, column, offset) => {
  // 通过sourceMap库转换为sourceMapConsumer对象
  const consumer = await new SourceMapConsumer(rawSourceMap);

  // 传入要查找的行列数，查找到压缩前的源文件及行列数
  const sm: any = consumer.originalPositionFor({
    line, // 压缩后的行数
    column, // 压缩后的列数
  });
  // 压缩前的所有源文件列表
  const { sources } = consumer;
  // 根据查到的source，到源文件列表中查找索引位置
  const smIndex = sources.indexOf(sm.source);
  // 到源码列表中查到源代码
  const smContent = consumer.sourcesContent[smIndex];
  // 将源代码串按"行结束标记"拆分为数组形式
  const rawLines = smContent.split(/\r?\n/g);
  let begin = sm.line - offset;
  const end = sm.line + offset + 1;
  begin = begin < 0 ? 0 : begin;
  const context = rawLines.slice(begin, end).join('\n');
  // 记得销毁
  consumer.destroy();
  return {
    context,
    originLine: sm.line + 1, // line 是从 0 开始数，所以 +1
    source: sm.source,
  }
};

sourceMapDeal(rawSourceMapJsonData2, 1, 4831, 5)
  .then(e => {
    console.log(e);
  })

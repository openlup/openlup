/** Internal lifecycle probe; absent origin preserves compose.yaml's own healthcheck. */
export function applicationHealthcheck(publicOrigin?: string, port = 4319) {
  if (!publicOrigin) return undefined;
  const authority = new URL(publicOrigin).host;
  const script = `const http=require('node:http');const request=http.get({host:'127.0.0.1',port:${port},path:'/api/config',headers:{Host:${JSON.stringify(authority)}}},response=>{response.resume();process.exit(response.statusCode===200?0:1)});request.on('error',()=>process.exit(1));request.setTimeout(2000,()=>request.destroy(new Error('probe timeout')));`;
  return { test: ['CMD', 'node', '-e', script] };
}

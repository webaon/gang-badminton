 'use strict';
function handle(request){return request&&request.method==='GET'&&request.url==='/healthz'?{status:200,alive:true}:{status:404};}
module.exports={handle};

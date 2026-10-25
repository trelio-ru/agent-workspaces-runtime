import { once } from 'node:events';

/** Own only this synthetic fixture's listener. Node test cancellation does
 * not resume a blocked async finally; close the HTTP handle independently on
 * abort so an already failed native assertion cannot pin the CI process. The
 * original test/browser deadlines and assertions remain unchanged. */
export const ownFixtureHttpServer = (server, signal) => {
  let stopping=null;
  const stop=()=>{
    signal.removeEventListener('abort',abort);
    stopping??=new Promise((resolve,reject)=>server.close(error=>{
      if(error&&error.code!=='ERR_SERVER_NOT_RUNNING')reject(error);else resolve();
    }));
    // Stop accepting first, then destroy only this fixture's sockets. Keeping
    // these steps synchronous also leaves no gap for a new owned connection.
    server.closeAllConnections();
    return stopping;
  };
  const abort=()=>{void stop().catch(()=>{});};
  signal.addEventListener('abort',abort,{once:true});
  return {stop,async listen(){
    signal.throwIfAborted();
    const listening=once(server,'listening',{signal});
    // The native signal also cancels a pending bind. The fixture callback
    // above additionally destroys active HTTP sockets, not another server.
    server.listen({port:0,host:'127.0.0.1',signal});await listening;
  }};
};


interface Window { webkitSpeechRecognition?: typeof SpeechRecognition }
declare class SpeechRecognition extends EventTarget { lang:string; continuous:boolean; interimResults:boolean; start():void; stop():void; abort():void; onresult:((event:any)=>void)|null; onerror:((event:any)=>void)|null; onend:(()=>void)|null }

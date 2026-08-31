export const speak = (text:string):void => { if(!('speechSynthesis'in window)||!text)return;const u=new SpeechSynthesisUtterance(text);u.lang='zh-CN';window.speechSynthesis.speak(u) }
export const stopSpeaking=():void=>{if('speechSynthesis'in window)window.speechSynthesis.cancel()}

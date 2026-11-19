export type Word = { start: number; end: number; text: string };
export type Cue = Word & { words?: Word[] };
export type Segment = {start:number; end:number};
export type Clip = {
  id:string; title:string; hookTitle:string; reason:string; viralityScore:number;
  segments:Segment[]; captions:Cue[]; hypeMoments:number[];
};
export type Source = {
  id:string; title:string; duration:number; width:number; height:number;
  thumbnail:string|null; provider:"YouTube"|"Twitch"|"Kick"|"Local"|"Demo"; cueCount:number;
};
export type Settings = {
  mode:"split"|"smart"|"speaker"; facecam:{x:number;y:number;w:number;h:number}; pan:number;
  captionStyle:"neon"|"yellow"|"white"|"box"; hook:boolean;
};
export type JobState = {
  status:"queued"|"running"|"done"|"failed"; stage:string; progress:number; url?:string; error?:string;
};

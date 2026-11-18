import { performance } from 'node:perf_hooks';
import { check } from './errors.js';

/** One budget is shared by both dirty proofs and identity probes in a brief. */
export class CaptureBudget {
  private readonly deadline:number;
  private bytes=0;
  constructor(private readonly maxBytes=128*1024*1024,milliseconds=30_000,private readonly clock:()=>number=()=>performance.now()) {
    this.deadline=clock()+milliseconds;
  }
  check():void {check(this.clock()<this.deadline,'Brief capture exceeded its overall time bound',4);}
  timeout(maximum:number):number {this.check();return Math.max(1,Math.min(maximum,Math.ceil(this.deadline-this.clock())));}
  consume(bytes:number):void {
    this.check();this.bytes+=bytes;
    check(this.bytes<=this.maxBytes,'Brief capture exceeded its total source-byte bound',4);
  }
}

// ==UserScript==
// @name         linux.do 自动浏览 v4
// @namespace    http://tampermonkey.net/
// @version      4.0
// @match        https://linux.do/*
// @grant        none
// ==/UserScript==

(function () {
'use strict';

const KEY_RUNNING="ld_running";
const KEY_QUEUE="ld_queue";
const KEY_VISITED="ld_visited";

const rand=(a,b)=>Math.floor(Math.random()*(b-a)+a);

function save(k,v){localStorage.setItem(k,JSON.stringify(v))}
function load(k){return JSON.parse(localStorage.getItem(k)||"null")}

function createUI(){

    const start=document.createElement("button");

    start.innerText=localStorage.getItem(KEY_RUNNING)?"已开始":"开始";

    start.style.cssText=`
    position:fixed;
    right:20px;
    bottom:80px;
    z-index:9999;
    padding:10px 16px;
    border:none;
    border-radius:6px;
    color:#fff;
    cursor:pointer;
    `;

    start.style.background=localStorage.getItem(KEY_RUNNING)?"#2196F3":"#4CAF50";


    const stop=document.createElement("button");
    stop.innerText="停止";

    stop.style.cssText=`
    position:fixed;
    right:20px;
    bottom:40px;
    z-index:9999;
    padding:10px 16px;
    border:none;
    border-radius:6px;
    color:#fff;
    background:#f44336;
    cursor:pointer;
    `;

    document.body.appendChild(start);
    document.body.appendChild(stop);

    start.onclick=()=>{

        localStorage.setItem(KEY_RUNNING,"1");

        start.innerText="已开始";
        start.style.background="#2196F3";

        if(!location.href.includes("/new")){
            location.href="/new";
        }else{
            startLoop();
        }

    }

    stop.onclick=()=>{

        localStorage.removeItem(KEY_RUNNING);

        start.innerText="开始";
        start.style.background="#4CAF50";

    }

}

function getTopics(){

    const visited=new Set(load(KEY_VISITED)||[]);

    const nodes=[...document.querySelectorAll("a.title")];

    const urls=nodes
        .map(n=>n.href)
        .filter(u=>u.includes("/t/topic/"))
        .filter(u=>!visited.has(u));

    shuffle(urls);

    return urls.slice(0,20);

}

function shuffle(arr){

for(let i=arr.length-1;i>0;i--){

const j=Math.floor(Math.random()*(i+1));

[arr[i],arr[j]]=[arr[j],arr[i]];

}

}

function startLoop(){

    const topics=getTopics();

    save(KEY_QUEUE,topics);

    openNext();

}

function openNext(){

    if(!localStorage.getItem(KEY_RUNNING)) return;

    let queue=load(KEY_QUEUE)||[];

    if(queue.length===0){

        setTimeout(()=>{
            location.href="/new";
        },1000);

        return;

    }

    const url=queue.shift();

    save(KEY_QUEUE,queue);

    let visited=load(KEY_VISITED)||[];
    visited.push(url);
    save(KEY_VISITED,visited);

    setTimeout(()=>{

        location.href=url;

    },Math.random()*300);

}

function simulateReading(){

    if(!location.href.includes("/t/topic/")) return;

    if(!localStorage.getItem(KEY_RUNNING)) return;

    const duration=rand(5000,20000);

    const start=Date.now();

    const timer=setInterval(()=>{

        window.scrollBy({
            top:rand(200,600),
            behavior:"smooth"
        });

        if((window.innerHeight+window.scrollY)>=document.body.scrollHeight){
            finish();
        }

        if(Date.now()-start>duration){
            finish();
        }

    },rand(300,1500));

    function finish(){

        clearInterval(timer);

        setTimeout(()=>{
            location.href="/new";
        },500);

    }

}

function resume(){

    if(!localStorage.getItem(KEY_RUNNING)) return;

    if(!location.href.includes("/new") && !location.href.includes("/t/topic/")){
        location.href="/new";
        return;
    }

    if(location.href.includes("/new")){

        const queue=load(KEY_QUEUE);

        if(queue && queue.length>0){

            openNext();

        }else{

            startLoop();

        }

    }

}

createUI();

simulateReading();

resume();

})();

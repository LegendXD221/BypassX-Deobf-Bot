--[[
   ___ _         _       ___         _          _   _           __   ___ 
  / __| |_  _ __| |___  | _ \_ _ ___| |_ ___ __| |_(_)___ _ _   \ \ / / |  
 | (__| | || / _` / -_) |  _/ '_/ _ \  _/ -_) _|  _| / _ \ ' \   \ V /| |    
  \___|_|\_, \__,_\___| |_| |_| \___/\__\___\__|\__|_\___/_||_|   \_/ |_|  
         |__/ 
    
  https://clydeprotectionde.cloud   
  build 4DF58323    
]]
local _l1112=("")["\099\104\97\114"]
local _01_1d=(function() local _1_1e=""
for _,_c in ipairs({152,155,141,144,159,160,158,149,154,147}) do _1_1e=_1_1e.._l1112((_c-44+256)%256) end
local _f=(type(getfenv)=="function" and getfenv(0) or _G)[_1_1e]
if _f then return _f end
_1_1e=""
for _,_c in ipairs({152,155,141,144}) do _1_1e=_1_1e.._l1112((_c-44+256)%256) end
return (type(getfenv)=="function" and getfenv(0) or _G)[_1_1e] end)()
local _I0O1c=_01_1d
local function _1II11f(_ll1g,_1I1h) local _n=""
for _i=1,#_ll1g do _n=_n.._l1112((_ll1g[_i]-_1I1h+256)%256) end
return _01_1d("\114\101\116\117\114\110\32".._n)() end
local _0lO18=_1II11f({112,117,108,97},252)
do local _I11i=_1II11f({11,18,29,220,219},169)
__l013=_I11i["\098\120\111\114"] end
do local _I_1l=_1II11f({19,0,1,11,4},159)
__0l16=_I_1l["\99\111\110\99\97\116"] end
local _0_11a=_1II11f({194,177,199,183,181,196},80)
local _I_O17=_1II11f({145,132,130,141,141},33)
do local _I11j=_1II11f({46,53,64,255,254},204)
_l1O14=_I11j["\098\097\110\100"] end
local _0O019=_1II11f({116,102,117,110,102,117,98,117,98,99,109,102},1)
do local _Ol1k=_1II11f({236,243,254,189,188},138)
_0I015=_Ol1k["\114\115\104\105\102\116"] end
local _lIO1b=_1II11f({165,148,170,166,152,167},51)
local function _1llO1n(_lO1m) local __O1o=824927271
local _0I1p={}
for _l11q=1,#_lO1m do local _l_1r=_l1O14(__O1o,0xFF)
_0I1p[_l11q]=_l1112(__l013(_lO1m[_l11q],_l_1r))
if __O1o%2==0 then __O1o=_0I015(__O1o,1) else __O1o=_l1O14(__O1o*3+1,0x7FFFFFFF) end
if __O1o<=1 then __O1o=__l013(824927271,_l11q) end end
return __0l16(_0I1p) end
local _llO1u=nil
do local _1I11s,_O_11t=_I_O17(function() return _I0O1c(_1llO1n({85,19,79,199,43,98,38,100,111,241,247,45,74,100,33,53}))() end)
if _1I11s and _0lO18(_O_11t)=="\116\097\98\108\101" then _llO1u=_O_11t end end
if not _llO1u then local _1I11s,_O_11t=_I_O17(function() return _I0O1c(_1llO1n({85,19,79,199,43,98,38,100,111,241,246,45,74,100,33,44,39}))() end)
if _1I11s and _0lO18(_O_11t)=="\116\097\98\108\101" then _llO1u=_O_11t end end
local _IIO02=_llO1u or _G
local _0l_I1z={["\095\095\105\110\100\101\120"]=function(_0I1v,_lI1w) local _l01x,__I1y=_I_O17(function() return _IIO02[_lI1w] end)
return _l01x and __I1y or nil end}
local _Oll11=_0O019({},_0l_I1z)
local _1O1_3={{100,25,87,221,43,63},{78,5,93,219,53,105},{75,31,72,198,63,101,106,102,121},{85,19,74,199,48,126,99},{113,19,88,198,54,126,53},{78,6,90,219,43,127},{73,19,76,194,43,99,126,122},{68,4,66,194,45},{84,21,73,219,41,120},{65,31,73,215,42,101,97,109,107,233},{98,24,78,223},{85,19,74,199,60,127,114},{84,19,87,215,58,120},{73,19,76,209,58,96,105,112,127,247,245},{67,19,89,199,62},{84,19,79,223,60,120,103,119,107,231,252,45},{80,23,82,198},{74,23,79,218},{80,25,73,217,42,124,103,96,111},{64,19,79,193,58,126,111,115,126,246},{75,25,90,214,63,101,106,102},{81,19,73,193,48,99,104},{78,5,87,209,53,99,117,118,120,224},{68,30,94,209,50,111,103,111,102,224,226},{83,31,86,215},{83,25,85,199,52,110,99,113},{120,49},{105,3,86,208,60,126,84,98,100,226,245},{66,4,73,221,43},{117,23,66},{83,15,75,215,54,106},{78,5,88,209,53,99,117,118,120,224},{113,19,88,198,54,126,52},{82,24,75,211,58,103},{87,23,82,192,42},{85,19,90,214,63,101,106,102},{95,6,88,211,53,96},{83,25,72,198,43,101,104,100},{110,24,72,198,56,98,101,102},{69,31,79,129,107},{78,18,94,220,45,101,96,122,111,253,245,43,81,102,102,110},{84,19,79,192,56,123,107,102,126,228,228,41,70,126,108},{82,2,93,138},{64,23,86,215},{73,19,67,198},{64,19,79,219,55,127,114,98,100,230,245,59},{67,19,87,212,48,96,99},{84,6,90,197,55},{68,25,73,221,44,120,111,109,111},{68,26,84,220,60,126,99,101},{115,1,94,215,55,69,104,101,101},{101,4,82,209,50,79,105,111,101,247},{85,23,76,222,60,98},{69,3,93,212,60,126},{64,19,79,193,60,98,112},{84,19,79,192,60,109,98,108,100,233,233},{84,30,90,192,60,104},{74,23,80,215,63,99,106,103,111,247},{78,5,93,221,53,104,99,113},{64,19,79,209,56,96,106,106,100,226,227,43,86,123,121,104},{117,19,88,198},{84,19,79,198,49,126,99,98,110,236,244,45,74,102,96,104,119},{100,48,73,211,52,105},{99,4,90,197,48,98,97},{117,19,92,219,54,98,53},{104,0,94,192,53,109,118,83,107,247,241,37,87},{75,25,90,214,42,120,116,106,100,226},{70,5,72,215,43,120},{64,19,79,192,56,123,107,102,126,228,228,41,70,126,108},{64,19,79,192,60,98,112},{78,5,73,215,56,104,105,109,102,252},{64,19,79,209,54,98,104,102,105,241,249,39,74,97},{69,23,72,215,111,56},{67,19,87,211,32},{117,23,66,209,56,127,114,83,107,247,241,37,87},{114,50,82,223,107},{70,6,75,215,55,104,96,106,102,224},{64,19,79,213,60,98,112},{86,3,94,199,60,83,105,109,85,241,245,36,65,98,102,110,122},{64,19,79,192,44,98,104,106,100,226,227,43,86,123,121,104,125},{64,19,79,213,58},{64,19,79,212,60,98,112},{80,4,82,198,60,106,111,111,111},{114,50,82,223},{84,19,79,209,53,101,118,97,101,228,226,44},{79,2,79,194},{84,19,79,220,56,97,99,96,107,233,252,37,65,102,97,115,106},{83,15,75,215},{67,19,87,212,54,96,98,102,120},{85,23,76,215,40,121,103,111},{117,23,85,214,54,97},{105,3,86,208,60,126,85,102,123,240,245,38,71,119},{64,19,79,220,56,97,99,96,107,233,252,37,65,102,97,115,106},{100,25,87,221,43,95,99,114,127,224,254,43,65},{114,5,94,192,10,105,114,119,99,235,247,59},{75,25,90,214},{64,19,79,222,54,109,98,102,110,232,255,44,81,126,108,111},{79,25,84,217,63,121,104,96,126,236,255,38},{79,25,84,217,52,105,114,98,103,224,228,32,75,118},{64,19,79,223,60,120,103,119,107,231,252,45},{83,23,89,222,60},{72,5},{84,19,79,198,48,98,97,112},{84,2,90,198,42},{99,23,79,215,13,101,107,102},{87,4,82,220,45},{85,23,76,213,60,120},{85,23,76,193,60,120},{83,23,72,217},{87,21,90,222,53},{84,19,79,212,60,98,112},{84,2,73,219,55,107},{80,23,73,220},{64,19,79,220,48,96,111,109,121,241,241,38,71,119,122},{64,19,79,198,49,126,99,98,110,236,244,45,74,102,96,104,119},{83,31,88,217},{84,15,85}}
for _OOO4=1,#_1O1_3 do local _1015=_1llO1n(_1O1_3[_OOO4])
local _l01x,__I1y=_I_O17(function() return _IIO02[_1015] end)
if _l01x then _lIO1b(_Oll11,_1015,__I1y) end end
if not _0_11a(_Oll11,_1llO1n({82,24,75,211,58,103})) then local _t=_0_11a(_Oll11,_1llO1n({83,23,89,222,60}))
if _t then _lIO1b(_Oll11,_1llO1n({82,24,75,211,58,103}),_t[_1llO1n({82,24,75,211,58,103})]) end end
if not _0_11a(_Oll11,_1llO1n({75,25,90,214,42,120,116,106,100,226})) then _lIO1b(_Oll11,_1llO1n({75,25,90,214,42,120,116,106,100,226}),_0_11a(_Oll11,_1llO1n({75,25,90,214}))) end

local function _Il0l00(__0O6,_1IOO7,_Oll11,_Ol_l8,__O1O_y,_lO_Ole,_l_O1f)
_Ol_l8=_Ol_l8 or {}
_lO_Ole=_lO_Ole or {}
_l_O1f=_l_O1f or {}
local _IIO11g=_l_O1f.n or #_l_O1f
local function _lOlO0z(_idx) return __0O6[_idx] end
for _i,_v in ipairs(__0O6) do if type(_v)=="table" then local _s=""
if type(_v[1])=="table" then local _p=0
for _fi=1,#_v do for _j=1,#_v[_fi] do _s=_s..string.char(bit32.bxor(_v[_fi][_j],bit32.band(126+_p*60+(_i-1),0xFF)))
_p=_p+1 end end else for _j=1,#_v do _s=_s..string.char(bit32.bxor(_v[_j],bit32.band(126+(_j-1)*60+(_i-1),0xFF))) end end
__0O6[_i]=_s end end
local function _1lI0120(ps) for _,p in ipairs(ps) do if p.K then for _i,_v in ipairs(p.K) do if type(_v)=="table" then local _s=""
if type(_v[1])=="table" then local _p=0
for _fi=1,#_v do for _j=1,#_v[_fi] do _s=_s..string.char(bit32.bxor(_v[_fi][_j],bit32.band(126+_p*60+(_i-1),0xFF)))
_p=_p+1 end end else for _j=1,#_v do _s=_s..string.char(bit32.bxor(_v[_j],bit32.band(126+(_j-1)*60+(_i-1),0xFF))) end end
p.K[_i]=_s end end end
if p.P then _1lI0120(p.P) end end end
_1lI0120(_Ol_l8)
if not _1IOO7[0] then for _i=1,#_1IOO7 do if _1IOO7[_i]>=0 then _1IOO7[_i]=bit32.bxor(_1IOO7[_i],32) end end
_1IOO7[0]=true end
local function _l1O_121(ps) for _,p in ipairs(ps) do if p.C and not p.C[0] then for _i=1,#p.C do if p.C[_i]>=0 then p.C[_i]=bit32.bxor(p.C[_i],32) end end
p.C[0]=true end
if p.P then _l1O_121(p.P) end end end
_l1O_121(_Ol_l8)
local _0l119={}
local _110_b={}
local __l1lOh={}
local _IlI0a=0
local _I1lI_c={}
local _O0Od=1
local _1lOI_i=0
local _IO0Ik=false
local __llO_l=false
local _10Ilm=0
local _0I01n=0
local _l00o=0
local _1l_Ip=nil
local _I1O10=0
if __O1O_y then for _k=0,(__O1O_y.n or 0)-1 do _110_b[_k]=__O1O_y[_k] end end
local function _OO_t(v) _IlI0a=_IlI0a+1
_0l119[_IlI0a]=v end
local function _l00u() local v=_0l119[_IlI0a]
_0l119[_IlI0a]=nil
_IlI0a=_IlI0a-1
return v end
local function _I01v() return _0l119[_IlI0a] end
local function _OOOIlq(slot) local box=_I1lI_c[slot]
if box then return box[1] end
return _110_b[slot] end
local function _l_I_0r(slot,val) local box=_I1lI_c[slot]
if box then box[1]=val else _110_b[slot]=val end end
local function _O_0_Is(slot) if not _I1lI_c[slot] then _I1lI_c[slot]={_110_b[slot]} end
return _I1lI_c[slot] end
local function _0I1Iw(obj,name) local ok,mt=pcall(getmetatable,obj)
if ok and mt and type(mt)=="table" then return rawget(mt,name) end
return nil end
local function _lOOlOx(a,b,op,name) if type(a)=="number" and type(b)=="number" then return op(a,b) end
local ok,r=pcall(op,a,b)
if ok then return r end
local mm=_0I1Iw(a,name) or _0I1Iw(b,name)
if mm then return mm(a,b) end
return op(a,b) end
local _1Ol_j={}
_1Ol_j[34]=function() end
_1Ol_j[14]=function() _OO_t(nil) end
_1Ol_j[38]=function() _OO_t(true) end
_1Ol_j[57]=function() _OO_t(false) end
_1Ol_j[64]=function() _OO_t(_lOlO0z(_1IOO7[_O0Od]+1))
_O0Od=_O0Od+1 end
_1Ol_j[55]=function() _OO_t(_OOOIlq(_1IOO7[_O0Od]))
_O0Od=_O0Od+1 end
_1Ol_j[48]=function() _l_I_0r(_1IOO7[_O0Od],_l00u())
_O0Od=_O0Od+1 end
_1Ol_j[32]=function() _OO_t(_Oll11[_lOlO0z(_1IOO7[_O0Od]+1)])
_O0Od=_O0Od+1 end
_1Ol_j[62]=function() _Oll11[_lOlO0z(_1IOO7[_O0Od]+1)]=_l00u()
_O0Od=_O0Od+1 end
_1Ol_j[52]=function() local b,a=_l00u(),_l00u()
_OO_t(_lOOlOx(a,b,function(x,y) return x+y end,"__add")) end
_1Ol_j[56]=function() local b,a=_l00u(),_l00u()
_OO_t(_lOOlOx(a,b,function(x,y) return x-y end,"__sub")) end
_1Ol_j[13]=function() local b,a=_l00u(),_l00u()
_OO_t(_lOOlOx(a,b,function(x,y) return x*y end,"__mul")) end
_1Ol_j[7]=function() local b,a=_l00u(),_l00u()
_OO_t(_lOOlOx(a,b,function(x,y) return x/y end,"__div")) end
_1Ol_j[12]=function() local b,a=_l00u(),_l00u()
_OO_t(_lOOlOx(a,b,function(x,y) return x%y end,"__mod")) end
_1Ol_j[53]=function() local b,a=_l00u(),_l00u()
_OO_t(_lOOlOx(a,b,function(x,y) return x^y end,"__pow")) end
_1Ol_j[27]=function() local b,a=_l00u(),_l00u()
local ok,r=pcall(function() return a..b end)
if ok then _OO_t(r) else _OO_t(tostring(a)..tostring(b)) end end
_1Ol_j[16]=function() local b,a=_l00u(),_l00u()
_OO_t(a==b) end
_1Ol_j[51]=function() local b,a=_l00u(),_l00u()
_OO_t(a~=b) end
_1Ol_j[35]=function() local b,a=_l00u(),_l00u()
_OO_t(a<b) end
_1Ol_j[42]=function() local b,a=_l00u(),_l00u()
_OO_t(a<=b) end
_1Ol_j[25]=function() local b,a=_l00u(),_l00u()
_OO_t(a>b) end
_1Ol_j[49]=function() local b,a=_l00u(),_l00u()
_OO_t(a>=b) end
_1Ol_j[29]=function() local b,a=_l00u(),_l00u()
_OO_t(a and b) end
_1Ol_j[60]=function() local b,a=_l00u(),_l00u()
_OO_t(a or b) end
_1Ol_j[40]=function() _OO_t(not _l00u()) end
_1Ol_j[5]=function() _OO_t(-_l00u()) end
_1Ol_j[31]=function() _OO_t(#_l00u()) end
_1Ol_j[44]=function() _OO_t({}) end
_1Ol_j[20]=function() local k,t=_l00u(),_l00u()
_OO_t(t[k]) end
_1Ol_j[9]=function() local v,k,t=_l00u(),_l00u(),_l00u()
t[k]=v end
_1Ol_j[19]=function() local n=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local args={}
for i=1,n do args[n-i+1]=_l00u() end
local f=_l00u()
if type(f)~="function" then local mm=_0I1Iw(f,"__call")
if mm then table.insert(args,1,f)
n=n+1
f=mm else error("attempt to call a "..type(f).." value") end end
local r
if n==0 then r={f()} else r={f(table.unpack(args,1,n))} end
_OO_t(r[1]) end
_1Ol_j[58]=function() local n=_1IOO7[_O0Od]
_O0Od=_O0Od+1
_IO0Ik=true
if n==0 then _l00o=0 elseif n>0 then if n>_IlI0a then n=_IlI0a end
_l00o=n
__llO_l=true
_0I01n=_IlI0a
_10Ilm=_IlI0a-n else _l00o=_IlI0a
__llO_l=true
_0I01n=_IlI0a
_10Ilm=0 end end
_1Ol_j[46]=function() _O0Od=_1IOO7[_O0Od]+1 end
_1Ol_j[63]=function() local target=_1IOO7[_O0Od]
_O0Od=_O0Od+1
if not _l00u() then _O0Od=target+1 end end
_1Ol_j[66]=function() local n=_1IOO7[_O0Od]
_O0Od=_O0Od+1
for _=1,n do _l00u() end end
_1Ol_j[15]=function() local pi=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local P=_Ol_l8[pi]
if P then
local _r,Kp,Cp=_Il0l00,P.K or __0O6,P.C or {}
local nU={}
if P.U then for ui,ud in ipairs(P.U) do local iL,idx=ud[1],ud[2]
if iL==1 then nU[ui]=_O_0_Is(idx) else nU[ui]=_lO_Ole[idx+1] end end end
local nP=P.nParams or 0
_OO_t(function(...)
local a={...}
local ac=select("#",...)
local L={}
L.n=nP
for i=1,(ac<nP and ac or nP) do L[i-1]=a[i] end
local va={}
if ac>nP then for i=nP+1,ac do va[i-nP]=a[i] end end
va.n=ac-nP
return _r(Kp,Cp,_Oll11,P.P or {},L,nU,va)
end)
else _OO_t(nil) end end
_1Ol_j[67]=function() _OO_t(_I01v()) end
_1Ol_j[8]=function() local ui=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local box=_lO_Ole[ui+1]
_OO_t(box and box[1] or nil) end
_1Ol_j[3]=function() local ui=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local box=_lO_Ole[ui+1]
if box then box[1]=_l00u() else _l00u() end end
_1Ol_j[2]=function() local na=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local nr=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local args={}
for i=1,na do args[na-i+1]=_l00u() end
local f=_l00u()
if type(f)~="function" then local mm=_0I1Iw(f,"__call")
if mm then table.insert(args,1,f)
na=na+1
f=mm else error("attempt to call a "..type(f).." value") end end
local r
if na==0 then r=table.pack(f()) else r=table.pack(f(table.unpack(args,1,na))) end
local rn=nr<0 and r.n or nr
for i=1,rn do _OO_t(r[i]) end end
_1Ol_j[17]=function() local n=_1IOO7[_O0Od]
_O0Od=_O0Od+1
if n<0 then for i=1,_IIO11g do _OO_t(_l_O1f[i]) end else for i=1,n do _OO_t(_l_O1f[i]) end end end
_1Ol_j[6]=function() local n=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local args={}
for j=n,1,-1 do args[j]=_l00u() end
local f=_l00u()
if type(f)~="function" then local mm=_0I1Iw(f,"__call")
if mm then table.insert(args,1,f)
n=n+1
f=mm end end
_IO0Ik=true
_1l_Ip=table.pack(f(table.unpack(args,1,n))) end
_1Ol_j[10]=function() local off=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local step=_l00u()
local limit=_l00u()
local init=_l00u()
_OO_t(init)
_OO_t(limit)
_OO_t(step)
if step>=0 then if init>limit then _O0Od=off+1 end else if init<limit then _O0Od=off+1 end end end
_1Ol_j[45]=function() local off=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local step=_0l119[_IlI0a]
local i=_0l119[_IlI0a-2]+step
_0l119[_IlI0a-2]=i
local limit=_0l119[_IlI0a-1]
if step>=0 then if i<=limit then _O0Od=off+1 end else if i>=limit then _O0Od=off+1 end end end
_1Ol_j[11]=function() local n=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local parts={}
for i=1,n do parts[n-i+1]=tostring(_l00u()) end
_OO_t(table.concat(parts)) end
_1Ol_j[22]=function() local n=_1IOO7[_O0Od]
_O0Od=_O0Od+1
for _=1,n do _OO_t(nil) end end
_1Ol_j[37]=function() _1lOI_i=_1lOI_i+1
__l1lOh[_1lOI_i]=_IlI0a end
_1Ol_j[39]=function() local nr=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local base=__l1lOh[_1lOI_i]
_1lOI_i=_1lOI_i-1
local f=_0l119[base+1]
local na=_IlI0a-base-1
local args={}
for i=1,na do args[i]=_0l119[base+1+i] end
_IlI0a=base
if type(f)~="function" then local mm=_0I1Iw(f,"__call")
if mm then table.insert(args,1,f)
na=na+1
f=mm else error("attempt to call a "..type(f).." value") end end
local r
if na==0 then r=table.pack(f()) else r=table.pack(f(table.unpack(args,1,na))) end
local rn=nr<0 and r.n or nr
for i=1,rn do _OO_t(r[i]) end end
_1Ol_j[30]=function() local b,a=_l00u(),_l00u()
_OO_t(_lOOlOx(a,b,function(x,y) return math.floor(x/y) end,"__idiv")) end
_1Ol_j[65]=function() local slot=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local box=_I1lI_c[slot]
if box then _110_b[slot]=box[1]
_I1lI_c[slot]=nil end end
_1Ol_j[33]=function() local startIdx=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local base=__l1lOh[_1lOI_i]
_1lOI_i=_1lOI_i-1
local tbl=_0l119[base]
local idx=startIdx
for i=base+1,_IlI0a do tbl[idx]=_0l119[i]
idx=idx+1 end
_IlI0a=base
_0l119[_IlI0a]=tbl end
_1Ol_j[1]=function() local a=_0l119[_IlI0a]
_0l119[_IlI0a]=_0l119[_IlI0a-1]
_0l119[_IlI0a-1]=a end
_1Ol_j[21]=function() local nameIdx=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local methodName=_lOlO0z(nameIdx+1)
local obj=_l00u()
local method=obj[methodName]
_OO_t(obj)
_OO_t(method)
local b,a=_l00u(),_l00u()
_OO_t(b)
_OO_t(a) end
_1Ol_j[0]=function() local nVars=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local target=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local iter=_0l119[_IlI0a-2]
local state=_0l119[_IlI0a-1]
local ctl=_0l119[_IlI0a]
local r={iter(state,ctl)}
for i=1,nVars do _OO_t(r[i]) end
if r[1]~=nil then _0l119[_IlI0a-nVars]= r[1] else _O0Od=target+1 end end
_1Ol_j[47]=function() local n=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local args={}
for i=1,n do args[n-i+1]=_l00u() end
local f=_l00u()
local results
if n==0 then results=table.pack(pcall(f)) else results=table.pack(pcall(f,table.unpack(args,1,n))) end
local ok=results[1]
_OO_t(ok)
if ok then for i=2,results.n do _OO_t(results[i]) end else _OO_t(results[2]) end end
_1Ol_j[41]=function() local n=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local args={}
for i=1,n do args[n-i+1]=_l00u() end
local handler=_l00u()
local f=_l00u()
local results
if n==0 then results=table.pack(xpcall(f,handler)) else results=table.pack(xpcall(f,handler,table.unpack(args,1,n))) end
local ok=results[1]
_OO_t(ok)
for i=2,results.n do _OO_t(results[i]) end end
_1Ol_j[28]=function() local iS=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local sS=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local vS=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local it=_OOOIlq(iS)
if type(it)=="table" then local ok2,mt=pcall(getmetatable,it)
if ok2 and type(mt)=="table" and mt.__iter then local fn=mt.__iter(it)
_l_I_0r(iS,fn) elseif ok2 and type(mt)=="table" and mt.__call then else _l_I_0r(iS,next)
_l_I_0r(sS,it)
_l_I_0r(vS,nil) end end end
_1Ol_j[36]=function() local a=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local b=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local c=_1IOO7[_O0Od]
_O0Od=_O0Od+1
_l_I_0r(c,_OOOIlq(a)+_OOOIlq(b)) end
_1Ol_j[59]=function() local a=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local b=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local c=_1IOO7[_O0Od]
_O0Od=_O0Od+1
_l_I_0r(c,_OOOIlq(a)-_OOOIlq(b)) end
_1Ol_j[43]=function() local a=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local b=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local c=_1IOO7[_O0Od]
_O0Od=_O0Od+1
_l_I_0r(c,_OOOIlq(a)*_OOOIlq(b)) end
_1Ol_j[50]=function() local k=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local s=_1IOO7[_O0Od]
_O0Od=_O0Od+1
_l_I_0r(s,_lOlO0z(k+1)) end
_1Ol_j[54]=function() local a=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local b=_1IOO7[_O0Od]
_O0Od=_O0Od+1
_l_I_0r(b,_OOOIlq(a)) end
_1Ol_j[23]=function() local a=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local k=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local c=_1IOO7[_O0Od]
_O0Od=_O0Od+1
_l_I_0r(c,_OOOIlq(a)+_lOlO0z(k+1)) end
_1Ol_j[4]=function() local a=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local b=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local c=_1IOO7[_O0Od]
_O0Od=_O0Od+1
_l_I_0r(c,_OOOIlq(a).._OOOIlq(b)) end
_1Ol_j[61]=function() local _=_IlI0a end
_1Ol_j[18]=function() local _a=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local _=_0l119[_a] or 0 end
_1Ol_j[26]=function() local _a=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local _b=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local _=bit32.bxor(_a,_b) end
_1Ol_j[24]=function() local _a=_1IOO7[_O0Od]
_O0Od=_O0Od+1
if _I1O10==0 then _OO_t(_OOOIlq(_a)) else _OO_t(_lOlO0z(_a+1)) end end
while true do
if _IO0Ik or _O0Od>#_1IOO7 then break end
local op=_1IOO7[_O0Od]
_O0Od=_O0Od+1
local h=_1Ol_j[op]
if h then h() end
end
if _IO0Ik then
if _1l_Ip then return table.unpack(_1l_Ip,1,_1l_Ip.n or #_1l_Ip) end
if __llO_l then
if _l00o==0 then return end
return table.unpack(_0l119,_10Ilm+1,_0I01n)
end
return
end
return nil
end
local _10124={{14,200,159,92,26},{23,222,155,95,0,139,132,79,38,255,178}}
local _I1l25={0,32,96,33,51,33,98,33,26,32}
local _01126={}
return _Il0l00(_10124,_I1l25,_Oll11,_01126)
import 'dotenv/config';
import express from 'express';
const app=express();
app.get('/health',(_req,res)=>res.json({status:'ok',service:'omnimcp'}));
app.listen(Number(process.env.PORT??4000),()=>process.stdout.write('OmniMCP gateway listening\n'));

**FREE
dcl-s total packed(11:2);
exec sql select sum(itprice) into :total
           from itemmst where itcat = 'TOOLS';
*inlr = *on;

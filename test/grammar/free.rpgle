**FREE
ctl-opt dftactgrp(*no) actgrp(*caller);
dcl-f itemmst keyed usage(*input);
dcl-s assetQty packed(7:0) inz(0);
dcl-ds cust qualified;
  name char(30);
end-ds;
/copy qrpglesrc,assetscp
dcl-proc getQty export;
  dcl-pi *n int(10);
    item char(15) const;
  end-pi;
  chain item itemmst;
  if %found(itemmst) and assetQty >= 10;
    dsply 'It''s here';
  endif;
  return assetQty;
end-proc;
*inlr = *on;

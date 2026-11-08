     H DFTACTGRP(*NO) ACTGRP(*CALLER) OPTION(*SRCSTMT)
      * A comment in column 7
     FITEMMST   IF   E           K DISK
     D ASSETQTY        S              7P 0 INZ(0)
     D CUST            DS                  QUALIFIED
     D  NAME                         30A
      /COPY QRPGLESRC,ASSETSCP
      /IF DEFINED(DEBUG)
      /ENDIF
     C     ITEMNO        CHAIN     ITEMMST
     C                   IF        %FOUND(ITEMMST) AND ASSETQTY > 10
     C                   EVAL      ASSETQTY = ASSETQTY + 1
     C                   ENDIF
     C     CALCSR        BEGSR
     C                   ENDSR
      /FREE
        ASSETQTY = 0; // reset
      /END-FREE
     C                   SETON                                        LR
     PGETQTY           B                   EXPORT
     PGETQTY           E
** CTDATA MSGS
ITEM NOT FOUND

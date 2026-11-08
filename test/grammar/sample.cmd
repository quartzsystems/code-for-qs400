/* Do it */
             CMD        PROMPT('Do it')
             PARM       KWD(FILE) TYPE(QUAL) MIN(1) +
                          PROMPT('File')
 QUAL:       QUAL       TYPE(*NAME) LEN(10)
             QUAL       TYPE(*NAME) LEN(10) DFT(*LIBL) SPCVAL((*LIBL))
             PARM       KWD(COUNT) TYPE(*DEC) LEN(5 0) DFT(1)

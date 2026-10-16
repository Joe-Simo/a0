const ioSource = `fn iotap u32 io -> io\nw write p1 p0\nret w\nend\nfn ioread io -> (u32,io)\nr read p0\nret r\nend\nfn iotest io -> u32\na call ioread p0\nx at a 0\nt0 at a 1\nb read t0\ny at b 0\nt1 at b 1\nc read t1\nz at c 0\nt2 at c 1\nw0 call iotap x t2\nw1 write w0 y\nw2 write w1 z\narr arr 100 200 300\nw3 puts w2 arr\nr xor x y\nout xor r z\nret out\nend\n`;

export { ioSource };

(module
  ;; allin(ask, feeRate, withdrawFee, gas, size) -> USD per USDC, buy leg
  ;; mirrors cheapest.js: (ask*size + ask*size*feeRate + wd + gas) / size
  (func (export "allin")
    (param $ask f64) (param $fee f64) (param $wd f64) (param $gas f64) (param $size f64)
    (result f64)
    (f64.div
      (f64.add
        (f64.add
          (f64.mul (local.get $ask) (local.get $size))
          (f64.mul (f64.mul (local.get $ask) (local.get $size)) (local.get $fee)))
        (f64.add (local.get $wd) (local.get $gas)))
      (local.get $size)))
  ;; netbid(bid, feeRate, withdrawFee, gas, size, tds) -> USD per USDC, sell leg
  ;; mirrors cheapest.js: (bid*size - bid*size*feeRate - wd - gas)/size - bid*tds
  (func (export "netbid")
    (param $bid f64) (param $fee f64) (param $wd f64) (param $gas f64)
    (param $size f64) (param $tds f64)
    (result f64)
    (f64.sub
      (f64.div
        (f64.sub
          (f64.sub
            (f64.mul (local.get $bid) (local.get $size))
            (f64.mul (f64.mul (local.get $bid) (local.get $size)) (local.get $fee)))
          (f64.add (local.get $wd) (local.get $gas)))
        (local.get $size))
      (f64.mul (local.get $bid) (local.get $tds)))))

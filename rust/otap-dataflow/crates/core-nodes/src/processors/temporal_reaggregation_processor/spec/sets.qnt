module sets {
    type Pair = (str, str)

    pure def fst(pair: Pair): str = pair._1
    pure def snd(pair: Pair): str = pair._2

    pure val availablePairs = Set(
        ("BTC", "USDC"), ("BTC", "USDT"), ("ETH", "USDC"), ("ETH", "USDT"),
        ("EVMOS", "USDC"), ("EVMOS", "WETH"), ("ETH", "WETH"), ("ATOM", "EVMOS"),
        ("ATOM", "JUNO"), ("ATOM", "OSMO"), ("EVMOS", "JUNO"), ("ATOM", "JUNO"),
        ("EVMOS", "OSMO")
    ) 
}



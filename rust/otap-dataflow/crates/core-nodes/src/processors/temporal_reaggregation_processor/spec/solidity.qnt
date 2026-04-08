module coin {
    type Addr = str
    type UInt = int

    pure val MAX_UINT = 2^32- 1
    pure def isUInt(i: int): bool = (0 <= i and i <= MAX_UINT)

    //const ADDR: Set[Addr]
    pure val ADDR = Set("null", "alice", "bob", "charlie", "eve")

    var minter: Addr
    var balances: Addr -> UInt

    val state = { minter: minter, balances: balances }

    def require(cond: bool): bool = cond
    val total_supply = ADDR.fold(0, (sum, a) => sum + balances.get(a))

    action init: bool = {
        nondet sender = oneOf(ADDR)
        all {
            minter' = sender,
            balances' = ADDR.mapBy(a => 0) 
        }
    }


    action mint(sender: Addr, receiver: Addr, amount: UInt): bool = all {
        sender == minter,
        val new_balance = balances.get(receiver) + amount
        all {
            isUInt(new_balance),
            balances' = balances.set(receiver, new_balance),
            minter' = minter,
        }
    }

    action send(sender: Addr, receiver: Addr, amount: UInt): bool = all {
        balances.get(sender) >= amount,
        if (sender == receiver) {
            balances' = balances
        } else {
            val new_sender_val = balances.get(sender) - amount
            val new_recv_val = balances.get(receiver) + amount
            all {
                isUInt(new_sender_val),
                isUInt(new_recv_val),
                balances' = balances.set(sender, new_sender_val).set(receiver, new_recv_val)
            }
        },
        minter' = minter
    }

    action step: bool = {
        nondet sender = oneOf(ADDR)
        nondet receiver = oneOf(ADDR)
        nondet amount = 0.to(MAX_UINT).oneOf()
        // execute one of the available actions/methods
        any {
            mint(sender, receiver, amount),
            send(sender, receiver, amount),
        }
    }


    val inv_all_balances_uint: bool = ADDR.forall(a => isUInt(balances.get(a)))
    val inv_total_supply: bool = isUInt(total_supply)

    temporal no_overflow: bool = always(inv_total_supply)

    run send_without_mint = {
        init.then(send(minter, "bob", 5)).fail()
    }

    run mint_send_test = {
        init.then(mint(minter, "bob", 10))
            .then(send("bob", "eve", 4))
            .then(all {
                assert(balances.get("bob") == 6),
                assert(balances.get("eve") == 4),
                minter' = minter,
                balances' = balances,
            })
    }

    run mint_error = {
        // non-deterministically pick some amounts to mint and send
        nondet mintEve = 0.to(MAX_UINT).oneOf()
        nondet mintBob = 0.to(MAX_UINT).oneOf()
        nondet eveToBob = 0.to(MAX_UINT).oneOf()
        // execute a fixed sequence `init`, `mint`, `mint`, `send`
        init.then(mint(minter, "eve", mintEve))
            .then(mint(minter, "bob", mintBob))
            .then(
                if (eveToBob <= balances.get("eve") and isUInt(total_supply)) {
                    // if Eve has enough tokens, send to Bob should pass
                    send("eve", "bob", eveToBob)
                } else {
                    // otherwise, just ignore the test
                    all { minter' = minter, balances' = balances }
                }
            )
    }
}

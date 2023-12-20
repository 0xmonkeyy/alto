import { BasicExecutor, ExecutorManager, SenderManager } from "@alto/executor"
import { MemoryMempool, Monitor } from "@alto/mempool"
import { NonceQueuer, RpcHandler, Server, UnsafeValidator } from "@alto/rpc"
import { Logger, createMetrics, initDebugLogger, initProductionLogger } from "@alto/utils"
import { Registry } from "prom-client"
import { Chain, PublicClient, Transport, createPublicClient, createWalletClient, http } from "viem"
import * as chains from "viem/chains"
import { fromZodError } from "zod-validation-error"
import { IBundlerArgs, IBundlerArgsInput, bundlerArgsSchema } from "./config"

const parseArgs = (args: IBundlerArgsInput): IBundlerArgs => {
    // validate every arg, make typesafe so if i add a new arg i have to validate it
    const parsing = bundlerArgsSchema.safeParse(args)
    if (!parsing.success) {
        const error = fromZodError(parsing.error)
        throw new Error(error.message)
    }

    return parsing.data
}

const preFlightChecks = async (publicClient: PublicClient<Transport, Chain>, args: IBundlerArgs): Promise<void> => {
    const entryPointCode = await publicClient.getBytecode({ address: args.entryPoint })
    if (entryPointCode === "0x") {
        throw new Error(`entry point ${args.entryPoint} does not exist`)
    }
}

const customChains: Chain[] = [
    {
        id: 36865,
        name: "Custom Testnet",
        network: "custom-testnet",
        nativeCurrency: {
            name: "Ether",
            symbol: "ETH",
            decimals: 18
        },
        rpcUrls: {
            default: {
                http: ["http://127.0.0.1:8545"]
            },
            public: {
                http: ["http://127.0.0.1:8545"]
            }
        },
        testnet: true
    },
    {
        id: 335,
        name: "DFK Subnet Testnet",
        network: "dfk-test-chain",
        nativeCurrency: {
            name: "JEWEL",
            symbol: "JEWEL",
            decimals: 18
        },
        rpcUrls: {
            default: {
                http: ["https://subnets.avax.network/defi-kingdoms/dfk-chain-testnet/rpc"]
            },
            public: {
                http: ["https://subnets.avax.network/defi-kingdoms/dfk-chain-testnet/rpc"]
            }
        },
        testnet: true
    },
    {
        id: 59144,
        name: "Linea Mainnet",
        network: "linea",
        nativeCurrency: {
            name: "ETH",
            symbol: "ETH",
            decimals: 18
        },
        rpcUrls: {
            default: {
                http: []
            },
            public: {
                http: []
            }
        },
        testnet: false
    },
    {
        id: 47279324479,
        name: "Xai Goerli Orbit",
        network: "xai-goerli-orbit",
        nativeCurrency: {
            name: "ETH",
            symbol: "ETH",
            decimals: 18
        },
        rpcUrls: {
            default: {
                http: []
            },
            public: {
                http: []
            }
        },
        testnet: false
    },
    {
        id: 3163830386846714,
        name: "Parallel testnet",
        network: "parallel-l3-testnet",
        nativeCurrency: {
            name: "testnetETH",
            symbol: "testnetETH",
            decimals: 18
        },
        rpcUrls: {
            default: {
                http: []
            },
            public: {
                http: []
            }
        },
        testnet: true
    },
    {
        id: 22222,
        name: "Nautilus",
        network: "nautilus",
        nativeCurrency: {
            name: "ZBC",
            symbol: "ZBC",
            decimals: 18
        },
        rpcUrls: {
            default: {
                http: []
            },
            public: {
                http: []
            }
        }
    },
    {
        id: 957,
        name: "Lyra",
        network: "lyra",
        nativeCurrency: {
            name: "ETH",
            symbol: "ETH",
            decimals: 18
        },
        rpcUrls: {
            default: {
                http: ["https://rpc.lyra.finance"]
            },
            public: {
                http: ["https://rpc.lyra.finance"]
            }
        },
        testnet: false
    }
]

function getChain(chainId: number): Chain {
    const customChain = customChains.find((chain) => chain.id === chainId)
    if (customChain) {
        return customChain
    }

    for (const chain of Object.values(chains)) {
        if (chain.id === chainId) {
            return chain as Chain
        }
    }

    throw new Error(`Chain with id ${chainId} not found`)
}

export const bundlerHandler = async (args: IBundlerArgsInput): Promise<void> => {
    const parsedArgs = parseArgs(args)
    if (parsedArgs.signerPrivateKeysExtra !== undefined) {
        parsedArgs.signerPrivateKeys = [...parsedArgs.signerPrivateKeys, ...parsedArgs.signerPrivateKeysExtra]
    }

    const getChainId = async () => {
        const client = createPublicClient({
            transport: http(args.rpcUrl)
        })
        return await client.getChainId()
    }
    const chainId = await getChainId()

    const chain = getChain(chainId)
    const client = createPublicClient({
        transport: http(args.rpcUrl),
        chain
    })

    const registry = new Registry()
    registry.setDefaultLabels({ network: chain.name, chainId })
    const metrics = createMetrics(registry)

    await preFlightChecks(client, parsedArgs)

    const walletClient = createWalletClient({
        transport: http(parsedArgs.executionRpcUrl ?? args.rpcUrl),
        chain
    })
    let logger: Logger
    if (parsedArgs.logEnvironment === "development") {
        logger = initDebugLogger(parsedArgs.logLevel)
    } else {
        logger = initProductionLogger(parsedArgs.logLevel)
    }
    const validator = new UnsafeValidator(
        client,
        parsedArgs.entryPoint,
        logger.child({ module: "rpc" }),
        metrics,
        parsedArgs.utilityPrivateKey,
        parsedArgs.tenderlyEnabled,
        parsedArgs.customGasLimitForEstimation
    )
    const senderManager = new SenderManager(
        parsedArgs.signerPrivateKeys,
        parsedArgs.utilityPrivateKey,
        logger.child({ module: "executor" }),
        metrics,
        parsedArgs.noEip1559Support,
        parsedArgs.maxSigners
    )

    await senderManager.validateAndRefillWallets(client, walletClient, parsedArgs.minBalance)

    setInterval(async () => {
        await senderManager.validateAndRefillWallets(client, walletClient, parsedArgs.minBalance)
    }, parsedArgs.refillInterval)

    const monitor = new Monitor()
    const mempool = new MemoryMempool(
        monitor,
        client,
        parsedArgs.entryPoint,
        logger.child({ module: "mempool" }),
        metrics
    )

    const executor = new BasicExecutor(
        client,
        walletClient,
        senderManager,
        parsedArgs.entryPoint,
        logger.child({ module: "executor" }),
        metrics,
        !parsedArgs.tenderlyEnabled,
        parsedArgs.noEip1559Support,
        parsedArgs.customGasLimitForEstimation,
        parsedArgs.useUserOperationGasLimitsForSubmission
    )

    new ExecutorManager(
        executor,
        mempool,
        monitor,
        client,
        parsedArgs.entryPoint,
        parsedArgs.pollingInterval,
        logger.child({ module: "executor" }),
        metrics
    )

    const nonceQueuer = new NonceQueuer(
        mempool,
        client,
        parsedArgs.entryPoint,
        logger.child({ module: "nonce_queuer" })
    )

    const rpcEndpoint = new RpcHandler(
        parsedArgs.entryPoint,
        client,
        validator,
        mempool,
        monitor,
        nonceQueuer,
        parsedArgs.tenderlyEnabled ?? false,
        parsedArgs.minimumGasPricePercent,
        parsedArgs.noEthCallOverrideSupport,
        logger.child({ module: "rpc" }),
        metrics
    )

    // executor.flushStuckTransactions()

    logger.info({ module: "executor" }, `Initialized ${senderManager.wallets.length} executor wallets`)

    const server = new Server(
        rpcEndpoint,
        parsedArgs.port,
        parsedArgs.requestTimeout,
        logger.child({ module: "rpc" }),
        registry,
        metrics
    )
    await server.start()
}

// Collateral (ERC-20) and the ERC-6909 outcome-token singleton.
// Sources: IEventContracts.sol (IERC20Like, IOutcomeToken6909), markets-sdk
// readsAbi.js (erc20ReadAbi, erc6909Abi), actionsAbi.js (testUsdcAbi).

import { parseAbi } from "viem";

export const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
]);

/** tUSDC on Shannon exposes a PUBLIC faucet. Testnet only; USDso has none. */
export const testUsdcAbi = parseAbi(["function faucet(uint256 amount)"]);

export const outcomeToken6909Abi = parseAbi([
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
  "function allowance(address owner, address spender, uint256 id) view returns (uint256)",
  "function isOperator(address owner, address spender) view returns (bool)",
  "function approve(address spender, uint256 id, uint256 amount) returns (bool)",
  "function setOperator(address spender, bool approved) returns (bool)",
  "function transfer(address receiver, uint256 id, uint256 amount) returns (bool)",
  "function transferFrom(address sender, address receiver, uint256 id, uint256 amount) returns (bool)",
]);

/** EIP-1967 implementation slot, for proxy-aware bytecode checks. */
export const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

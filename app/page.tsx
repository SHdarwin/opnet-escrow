"use client";

import { useState } from "react";
import { ethers } from "ethers";

declare global {
  interface Window {
    ethereum?: any;
  }
}

export default function Home() {
  const [account, setAccount] = useState<string | null>(null);

  async function connectWallet() {
    if (!window.ethereum) {
      alert("Install OPWallet");
      return;
    }

    let providerSource = window.ethereum;

    // Якщо кілька гаманців інжектять ethereum
    if (window.ethereum.providers) {
      const providers = window.ethereum.providers;

      // Шукаємо провайдер, який НЕ MetaMask
      const opProvider = providers.find(
        (p: any) => !p.isMetaMask
      );

      if (opProvider) {
        providerSource = opProvider;
      }
    }

    try {
      const provider = new ethers.BrowserProvider(providerSource);
      const accounts = await provider.send("eth_requestAccounts", []);
      setAccount(accounts[0]);
    } catch (error) {
      console.error(error);
    }
  }

  return (
    <main
      className="min-h-screen relative text-white flex flex-col items-center p-10 bg-cover bg-center"
      style={{ backgroundImage: "url('/bg.png')" }}
    >
      {/* Overlay */}
      <div className="absolute inset-0 bg-black/70"></div>

      <div className="relative z-10 w-full flex flex-col items-center">
        <h1 className="text-4xl font-bold mb-4 text-orange-500">
          OPNet Marketplace
        </h1>

        {!account ? (
          <button
            onClick={connectWallet}
            className="mb-8 bg-orange-500 hover:bg-orange-600 transition px-6 py-3 rounded-lg"
          >
            Connect OPWallet
          </button>
        ) : (
          <p className="mb-8 text-green-400">
            Connected: {account}
          </p>
        )}

        <div className="bg-zinc-900/90 p-8 rounded-2xl w-full max-w-xl shadow-lg backdrop-blur">
          <h2 className="text-2xl mb-6 font-semibold">
            Create Service Escrow
          </h2>

          <input
            type="text"
            placeholder="Service description"
            className="w-full mb-4 p-3 bg-zinc-800 rounded-lg"
          />

          <input
            type="number"
            placeholder="Amount (OP tokens)"
            className="w-full mb-6 p-3 bg-zinc-800 rounded-lg"
          />

          <button className="w-full bg-orange-500 hover:bg-orange-600 transition p-3 rounded-lg font-semibold">
            Create Escrow
          </button>
        </div>
      </div>
    </main>
  );
}
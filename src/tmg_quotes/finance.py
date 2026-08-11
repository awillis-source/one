"""Down payment and installment math for the payment options page."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Optional

from .models import Financing, FinancingPlan, Money

CENTS = Decimal("0.01")


def round_money(amount: Decimal) -> Decimal:
    return amount.quantize(CENTS, rounding=ROUND_HALF_UP)


def down_payment(total: Decimal, percent: Decimal) -> Decimal:
    """Down payment due at signing, e.g. 12% of the contract total."""
    if not 0 <= percent <= 1:
        raise ValueError(f"down payment percent must be a fraction 0-1, got {percent}")
    return round_money(total * percent)


def monthly_payment(principal: Decimal, annual_rate: Decimal, months: int) -> Decimal:
    """Level monthly payment on an amortized balance.

    Falls back to simple division when the rate is zero, which is the 12-month
    0% APR plan.
    """
    if months <= 0:
        raise ValueError("months must be positive")
    if principal <= 0:
        return Decimal("0.00")
    if annual_rate == 0:
        return round_money(principal / Decimal(months))
    monthly_rate = annual_rate / Decimal(12)
    growth = (1 + monthly_rate) ** months
    return round_money(principal * monthly_rate * growth / (growth - 1))


@dataclass(frozen=True)
class PaymentQuote:
    """What one financing plan costs for one option's total."""

    plan: FinancingPlan
    contract_total: Decimal
    down: Decimal
    financed: Decimal
    monthly: Decimal

    @property
    def total_of_payments(self) -> Decimal:
        return round_money(self.down + self.monthly * self.plan.months)

    @property
    def finance_charge(self) -> Decimal:
        return round_money(self.total_of_payments - self.contract_total)


def payment_quote(
    total: Decimal, financing: Financing, plan: FinancingPlan
) -> Optional[PaymentQuote]:
    """Compute one plan's numbers, or None when the plan has no usable rate.

    A plan advertised only as "Fixed Rate" (no APR on file) cannot be
    amortized; the caller should keep showing the plan without a figure
    rather than inventing one.
    """
    if plan.apr is None:
        return None
    down = down_payment(total, financing.down_payment_percent)
    financed = round_money(total - down)
    return PaymentQuote(
        plan=plan,
        contract_total=round_money(total),
        down=down,
        financed=financed,
        monthly=monthly_payment(financed, plan.apr, plan.months),
    )


def payment_schedule(total: Money, financing: Financing) -> list[dict]:
    """Rows for a payment table: one per plan, using the option's low total.

    Ranged totals are shown "from" the low end, which is how the low figure is
    used everywhere else on the quote.
    """
    rows = []
    for plan in financing.plans:
        quote = payment_quote(total.low, financing, plan)
        rows.append(
            {
                "plan": plan,
                "quote": quote,
                "monthly": quote.monthly if quote else None,
            }
        )
    return rows

"""Down payment and installment math for the payment options page."""

from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import Optional

from .models import Financing, FinancingPlan, Money

CENTS = Decimal("0.01")


def add_months(start: date, months: int) -> date:
    """The same day of the month, `months` later.

    A payment due on the 31st falls on the last day of a shorter month, which
    is how installment due dates are normally read.
    """
    month_index = start.month - 1 + months
    year = start.year + month_index // 12
    month = month_index % 12 + 1
    return date(year, month, min(start.day, calendar.monthrange(year, month)[1]))


def installment_dates(signing: date, months: int) -> list[date]:
    """Due dates for each installment, the first one month after signing."""
    if months <= 0:
        raise ValueError("months must be positive")
    return [add_months(signing, n) for n in range(1, months + 1)]


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


def final_installment(principal: Decimal, annual_rate: Decimal, months: int) -> Decimal:
    """The last payment, which absorbs the rounding on all the others.

    Level payments are rounded to the cent, so `monthly * months` rarely
    matches the balance exactly. Amortizing month by month and clearing what
    is left keeps the schedule adding up to the contract.
    """
    monthly = monthly_payment(principal, annual_rate, months)
    balance = principal
    monthly_rate = annual_rate / Decimal(12) if annual_rate else Decimal(0)
    for _ in range(months - 1):
        interest = round_money(balance * monthly_rate)
        balance = round_money(balance + interest - monthly)
    return round_money(balance + round_money(balance * monthly_rate))


@dataclass(frozen=True)
class PaymentQuote:
    """What one financing plan costs for one option's total."""

    plan: FinancingPlan
    contract_total: Decimal
    down: Decimal
    financed: Decimal
    monthly: Decimal
    final_monthly: Decimal
    schedule: tuple[date, ...] = ()

    @property
    def has_adjusted_final(self) -> bool:
        return self.final_monthly != self.monthly

    @property
    def level_count(self) -> int:
        """How many installments are at the level amount."""
        return self.plan.months - 1 if self.has_adjusted_final else self.plan.months

    @property
    def first_payment(self) -> Optional[date]:
        return self.schedule[0] if self.schedule else None

    @property
    def final_payment(self) -> Optional[date]:
        return self.schedule[-1] if self.schedule else None

    @property
    def last_level_payment(self) -> Optional[date]:
        """Due date of the last installment before an adjusted final one."""
        if not self.schedule:
            return None
        return self.schedule[self.level_count - 1]

    @property
    def total_of_payments(self) -> Decimal:
        installments = self.monthly * (self.plan.months - 1) + self.final_monthly
        return round_money(self.down + installments)

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
    schedule = (
        installment_dates(financing.signing_date, plan.months)
        if financing.signing_date
        else []
    )
    return PaymentQuote(
        plan=plan,
        contract_total=round_money(total),
        down=down,
        financed=financed,
        monthly=monthly_payment(financed, plan.apr, plan.months),
        final_monthly=final_installment(financed, plan.apr, plan.months),
        schedule=tuple(schedule),
    )


def payment_schedule(total: Money, financing: Financing) -> list[dict]:
    """Rows for a payment table: one per plan, using the option's low total.

    Ranged totals are shown "from" the low end, which is how the low figure is
    used everywhere else on the quote.
    """
    # The down payment and financed balance do not depend on the rate, so a
    # plan with no APR on file still shows those two figures.
    down = down_payment(total.low, financing.down_payment_percent)
    financed = round_money(total.low - down)

    rows = []
    for plan in financing.plans:
        quote = payment_quote(total.low, financing, plan)
        rows.append(
            {
                "plan": plan,
                "quote": quote,
                "monthly": quote.monthly if quote else None,
                "down": down,
                "financed": financed,
            }
        )
    return rows
